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
    let disposableRunBlock = vscode.commands.registerCommand('vscode-dynomark.runDynomarkBlock', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No editor is active');
            return;
        }
        const document = editor.document;
        const selection = editor.selection;
        const cursorPosition = editor.selection.active;
        const text = document.getText();

        checkDynomarkAvailability().then(dynomarkPath => {
            // Find the dynomark block where the cursor is located
            const { content: dynomarkBlock, endPosition } = findDynomarkBlockAtPosition(text, cursorPosition);

            if (!dynomarkBlock) {
                vscode.window.showInformationMessage('Cursor is not inside a dynomark code block.');
                return;
            }

            const provider = new DynomarkContentProvider();
            vscode.workspace.registerTextDocumentContentProvider('dynomark-results', provider);

            const currentFileDirectory = path.dirname(document.fileName);
            const command = `${dynomarkPath} --query '${dynomarkBlock}'`;

            exec(command, { cwd: currentFileDirectory }, (error: { message: any; }, stdout: any, stderr: any) => {
                if (error) {
                    vscode.window.showErrorMessage(`Error running command: ${error.message}`);
                    return;
                }
                if (stderr) {
                    vscode.window.showWarningMessage(`stderr: ${stderr}`);
                }

                provider.updateContent(stdout.trim());

                const virtualDocUri = vscode.Uri.parse('dynomark-results:results.md');
                if (endPosition) {
                    vscode.commands.executeCommand('editor.action.peekLocations', editor.document.uri, endPosition, [
                        new vscode.Location(virtualDocUri, new vscode.Position(0, 0))
                    ]).then(() => {
                        console.log('Peek command executed.');
                    }, (err) => {
                        vscode.window.showErrorMessage(`Error executing peek command: ${err}`);
                    });
                } else {
                    vscode.window.showErrorMessage('End position is undefined.');
                }
            });
        }).catch(() => {
            vscode.window.showErrorMessage('Dynomark is not available on this system.', 'Download Dynomark').then(selection => {
                if (selection === 'Download Dynomark') {
                    downloadDynomark().then(dynomarkPath => {
                        vscode.window.showInformationMessage(`Dynomark downloaded to ${dynomarkPath}`);
                    }).catch(err => {
                        vscode.window.showErrorMessage(`Failed to download Dynomark: ${err}`);
                    });
                }
            });
        });
    });

    let disposableCompileDocument = vscode.commands.registerCommand('vscode-dynomark.compileDocument', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No editor is active');
            return;
        }
        const document = editor.document;
        const text = document.getText();

        // Determine the command to check for dynomark
        checkDynomarkAvailability().then(dynomarkPath => {
            // Extract all dynomark blocks
            const dynomarkBlocks = extractDynomarkCodeBlocks(text);
            let modifiedText = text;
            let promises = dynomarkBlocks.map(block => {
                return new Promise<void>((resolve, reject) => {
                    const command = `${dynomarkPath} --query '${block}'`;
                    exec(command, (error: { message: any; }, stdout: any, stderr: any) => {
                        if (error) {
                            reject(`Error running command: ${error.message}`);
                            return;
                        }
                        if (stderr) {
                            vscode.window.showWarningMessage(`stderr: ${stderr}`);
                        }
                        modifiedText = modifiedText.replace(`\`\`\`dynomark\n${block}\n\`\`\``, stdout.trim());
                        resolve();
                    });
                });
            });

            Promise.all(promises).then(() => {
                // Create a new document with the modified content
                vscode.workspace.openTextDocument({ content: modifiedText, language: 'markdown' }).then(doc => {
                    vscode.window.showTextDocument(doc);
                });
            }).catch(err => {
                vscode.window.showErrorMessage(err);
            });
        }).catch(() => {
            vscode.window.showErrorMessage('Dynomark is not available on this system.', 'Download Dynomark').then(selection => {
                if (selection === 'Download Dynomark') {
                    downloadDynomark().then(dynomarkPath => {
                        vscode.window.showInformationMessage(`Dynomark downloaded to ${dynomarkPath}`);
                    }).catch(err => {
                        vscode.window.showErrorMessage(`Failed to download Dynomark: ${err}`);
                    });
                }
            });
        });
    });

    context.subscriptions.push(disposableCompileDocument);
    context.subscriptions.push(disposableRunBlock);
}

/**
 * Extracts all code blocks with the language identifier 'dynomark' from the given Markdown text.
 * @param markdownText The text content of the Markdown document.
 * @returns An array of strings, each representing the content inside a 'dynomark' code block.
 */
function extractDynomarkCodeBlocks(markdownText: string): string[] {
    const dynomarkBlocks: string[] = [];
    const regex = /```dynomark\s*\n([\s\S]*?)\n```/g;
    let match;
    while ((match = regex.exec(markdownText)) !== null) {
        dynomarkBlocks.push(match[1].trim());
    }
    return dynomarkBlocks;
}

/**
 * Finds the dynomark code block at the given cursor position.
 * @param markdownText The full text of the markdown document.
 * @param position The cursor position (vscode.Position).
 * @returns The content inside the dynomark block if found and the end position of the block if found.
 */
function findDynomarkBlockAtPosition(markdownText: string, position: vscode.Position): { content: string | null, endPosition: vscode.Position | null } {
    const regex = /```dynomark\s*\n([\s\S]*?)\n```/g;
    let match;
    let blockStart = 0;

    // Search for dynomark code blocks
    while ((match = regex.exec(markdownText)) !== null) {
        const blockStartIndex = match.index;
        const blockEndIndex = regex.lastIndex;

        // Get the start and end line numbers of the code block
        const startLine = markdownText.slice(0, blockStartIndex).split('\n').length - 1;
        const endLine = markdownText.slice(0, blockEndIndex).split('\n').length - 1;

        // Check if the cursor is inside the block
        if (position.line >= startLine && position.line <= endLine) {
            return {
                content: match[1].trim(),
                endPosition: new vscode.Position(endLine, 0)
            };
        }
    }

    return { content: null, endPosition: null };  // Return null if no block found
}

function checkDynomarkAvailability(): Promise<string> {
    return new Promise((resolve, reject) => {
        const checkCommand = process.platform === 'win32' ? 'where dynomark' : 'which dynomark';
        exec(checkCommand, (error: any, stdout: string, stderr: string) => {
            if (error) {
                // Dynomark not found in PATH, check if we have a downloaded version
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
                    // Follow the redirection
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

export function deactivate() {}