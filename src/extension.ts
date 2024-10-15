import * as path from 'path';
import * as vscode from 'vscode';
import * as https from 'https';
import * as fs from 'fs';
const { exec } = require('child_process');

let DYNOMARK_URL: string;
let DYNOMARK_EXECUTABLE: string;

// check OS and build url accordingly
switch (process.platform) {
    case 'win32':
        DYNOMARK_URL = 'https://github.com/k-lar/dynomark/releases/latest/download/dynomark.exe';
        DYNOMARK_EXECUTABLE = 'dynomark.exe';
        break;
    case 'linux':
        DYNOMARK_URL = 'https://github.com/k-lar/dynomark/releases/latest/download/dynomark-linux';
        DYNOMARK_EXECUTABLE = 'dynomark-linux';
        break;
    case 'darwin':
        DYNOMARK_URL = 'https://github.com/k-lar/dynomark/releases/latest/download/dynomark-macos';
        DYNOMARK_EXECUTABLE = 'dynomark-macos';
        break;
    default:
        vscode.window.showInformationMessage('Unsupported platform detected. Please download Dynomark manually and add it to your PATH environment variable.');
}

class DynomarkContentProvider implements vscode.TextDocumentContentProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    private content: string = '';

    get onDidChange(): vscode.Event<vscode.Uri> {
        return this._onDidChange.event;
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.content;
    }

    updateContent(newContent: string) {
        this.content = newContent;
        this._onDidChange.fire(vscode.Uri.parse('dynomark-results:results.md'));
    }
}

export function activate(context: vscode.ExtensionContext) {
    let disposableRunBlock = vscode.commands.registerCommand('vscode-dynomark.runDynomarkBlock', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No editor is active');
            return;
        }
        const document = editor.document;
        const selection = editor.selection;
        const cursorPosition = editor.selection.active;
        const text = document.getText();

        try {
            const dynomarkPath = await checkDynomarkAvailability();
            const { content: dynomarkBlock, endPosition } = findDynomarkBlockAtPosition(text, cursorPosition);

            if (!dynomarkBlock) {
                vscode.window.showInformationMessage('Cursor is not inside a dynomark code block.');
                return;
            }

            const provider = new DynomarkContentProvider();
            vscode.workspace.registerTextDocumentContentProvider('dynomark-results', provider);

            const currentFileDirectory = path.dirname(document.fileName);
            const query = dynomarkBlock.replace(/"/g, '\\"'); // Escape double quotes

            try {
                const result = await retryDynomarkExecution(dynomarkPath, query, currentFileDirectory);
                provider.updateContent(result);

                const virtualDocUri = vscode.Uri.parse('dynomark-results:results.md');
                if (endPosition) {
                    await vscode.commands.executeCommand('editor.action.peekLocations', editor.document.uri, endPosition, [
                        new vscode.Location(virtualDocUri, new vscode.Position(0, 0))
                    ]);
                    console.log('Peek command executed.');
                } else {
                    vscode.window.showErrorMessage('End position is undefined.');
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Error executing Dynomark command: ${error}`);
            }
        } catch (error) {
            vscode.window.showErrorMessage('Dynomark is not available on this system.', 'Download Dynomark').then(selection => {
                if (selection === 'Download Dynomark') {
                    downloadDynomark().then(dynomarkPath => {
                        vscode.window.showInformationMessage(`Dynomark downloaded to ${dynomarkPath}`);
                    }).catch(err => {
                        vscode.window.showErrorMessage(`Failed to download Dynomark: ${err}`);
                    });
                }
            });
        }
    });

    let disposableCompileDocument = vscode.commands.registerCommand('vscode-dynomark.compileDocument', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No editor is active');
            return;
        }
        const document = editor.document;
        const text = document.getText();
    
        try {
            const dynomarkPath = await checkDynomarkAvailability();
            const dynomarkBlocks = extractDynomarkCodeBlocks(text);
            let modifiedText = text;
    
            console.log(`Found ${dynomarkBlocks.length} Dynomark blocks to process`);
    
            for (let i = 0; i < dynomarkBlocks.length; i++) {
                const block = dynomarkBlocks[i];
                console.log(`Processing block ${i + 1}/${dynomarkBlocks.length}`);
                console.log(`Block content: ${block}`);
        
                const currentFileDirectory = path.dirname(document.fileName);
                const query = block.replace(/"/g, '\\"');
                try {
                    console.log(`Executing query: ${query}`);
                    const result = await retryDynomarkExecution(dynomarkPath, query, currentFileDirectory);
                    console.log(`Execution result: ${result}`);
        
                    const blockRegex = createSafeBlockRegex(block);
                    const beforeReplace = modifiedText;
                    modifiedText = modifiedText.replace(blockRegex, result);
                    
                    if (beforeReplace === modifiedText) {
                        console.warn(`Block ${i + 1} was not replaced in the text. This might indicate a matching problem.`);
                        console.log(`Regex used: ${blockRegex}`);
                    } else {
                        console.log(`Block ${i + 1} successfully replaced`);
                    }
                } catch (error) {
                    console.error(`Error processing block ${i + 1}: ${block}`, error);
                    vscode.window.showWarningMessage(`Failed to process Dynomark block ${i + 1}: ${error}`);
                }
            }
    
            console.log(`All blocks processed. Opening new document.`);
            const newDoc = await vscode.workspace.openTextDocument({ content: modifiedText, language: 'markdown' });
            await vscode.window.showTextDocument(newDoc);
        } catch (error) {
            console.error('Error in compileDocument:', error);
            vscode.window.showErrorMessage(`Error compiling document: ${error}`);
        }
    });

    context.subscriptions.push(disposableCompileDocument);
    context.subscriptions.push(disposableRunBlock);
}

function extractDynomarkCodeBlocks(markdownText: string): string[] {
    const dynomarkBlocks: string[] = [];
    const regex = /```dynomark\s*\n([\s\S]*?)\n\s*```/g;
    let match;
    while ((match = regex.exec(markdownText)) !== null) {
        dynomarkBlocks.push(match[1].trim());
    }
    return dynomarkBlocks;
}

function findDynomarkBlockAtPosition(markdownText: string, position: vscode.Position): { content: string | null, endPosition: vscode.Position | null } {
    const regex = /```dynomark\s*\n([\s\S]*?)\n```/g;
    let match;
    let blockStart = 0;

    while ((match = regex.exec(markdownText)) !== null) {
        const blockStartIndex = match.index;
        const blockEndIndex = regex.lastIndex;

        const startLine = markdownText.slice(0, blockStartIndex).split('\n').length - 1;
        const endLine = markdownText.slice(0, blockEndIndex).split('\n').length - 1;

        if (position.line >= startLine && position.line <= endLine) {
            return {
                content: match[1].trim(),
                endPosition: new vscode.Position(endLine, 0)
            };
        }
    }

    return { content: null, endPosition: null };
}

function checkDynomarkAvailability(): Promise<string> {
    return new Promise((resolve, reject) => {
        const checkCommand = process.platform === 'win32' ? 'where dynomark' : 'which dynomark';
        exec(checkCommand, (error: any, stdout: string, stderr: string) => {
            if (error) {
                const dynomarkPath = path.join(__dirname, DYNOMARK_EXECUTABLE);
                if (fs.existsSync(dynomarkPath)) {
                    resolve(dynomarkPath);
                } else {
                    reject();
                }
            } else {
                resolve('dynomark');
            }
        });
    });
}

function downloadDynomark(): Promise<string> {
    return new Promise((resolve, reject) => {
        const dynomarkPath = path.join(__dirname, DYNOMARK_EXECUTABLE);
        const file = fs.createWriteStream(dynomarkPath);

        const download = (url: string) => {
            https.get(url, response => {
                if (response.statusCode === 200) {
                    response.pipe(file);
                    file.on('finish', () => {
                        file.close(() => {
                            if (process.platform !== 'win32') {
                                fs.chmod(dynomarkPath, '755', (err) => {
                                    if (err) {
                                        reject(`Failed to set execute permissions: ${err.message}`);
                                    } else {
                                        resolve(dynomarkPath);
                                    }
                                });
                            } else {
                                resolve(dynomarkPath);
                            }
                        });
                    });
                } else if (response.statusCode === 302 && response.headers.location) {
                    download(response.headers.location);
                } else {
                    reject(`Failed to download Dynomark: ${response.statusCode}`);
                }
            }).on('error', err => {
                fs.unlink(dynomarkPath, () => reject(err.message));
            });
        };

        download(DYNOMARK_URL);
    });
}

function executeDynomarkCommand(dynomarkPath: string, query: string, currentFileDirectory: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const command = `${dynomarkPath} --query "${query}"`;
        const childProcess = exec(command, { cwd: currentFileDirectory }, (error: any, stdout: string, stderr: string) => {
            if (error) {
                reject(`Error running command: ${error.message}`);
                return;
            }
            if (stderr) {
                console.warn(`stderr: ${stderr}`);
            }
            resolve(stdout.trim());
        });

        const timeout = setTimeout(() => {
            childProcess.kill();
            reject('Dynomark command timed out');
        }, 10000);

        childProcess.on('exit', () => clearTimeout(timeout));
    });
}

async function retryDynomarkExecution(dynomarkPath: string, query: string, currentFileDirectory: string, maxRetries = 3): Promise<string> {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await executeDynomarkCommand(dynomarkPath, query, currentFileDirectory);
        } catch (error) {
            console.warn(`Dynomark execution failed (attempt ${i + 1}/${maxRetries}):`, error);
            if (i === maxRetries - 1) {
                throw error;
            }
        }
    }
    throw new Error('Max retries reached');
}

function escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

function createSafeBlockRegex(block: string): RegExp {
    const escapedBlock = escapeRegExp(block);
    return new RegExp(`\`\`\`dynomark\\r?\\n${escapedBlock}\\r?\\n\`\`\``, 'g');
}

export function deactivate() {}