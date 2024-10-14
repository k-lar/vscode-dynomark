# Dynomark inside VSCode

vscode-dynomark allows you to query your markdown files with a simple query language that resembles SQL.
This is possible by using [Dynomark](https://github.com/k-lar/dynomark), an editor agnostic markdown query language engine.
This extension is a wrapper around that engine, and provides a simple way to query your markdown
files.

## Features

The main way to use this extension is by writing a query in your markdown file with a fenced code
block that has the language set to `dynomark`. For example:

`````
```dynomark
TASK FROM examples/, my_todos/ WHERE NOT CHECKED
```
`````

With the cursor inside the code block, you can press `Ctrl+Shift+P` and search for `Dynomark: Run
Dynomark block under cursor`. This will evaluate the query and show the results below the query in a
peek view. This is also available as a context menu option when right clicking inside markdown
files.

There is also a command to "compile" all the queries in the currently opened markdown file. This
will open a new window on the right side of the editor with all the queries in the file evaluated
and replaced with the results. This is only available as a command in the command palette
(`Ctrl+Shift+P`).

> [!NOTE]
> The query language is still in development, and the features available are limited.
> You can check the engine's github for more information on the query language and its features.
