# Cyber Security Website Projects

This repository contains four independent applications:

| Folder | Local address | Start command |
| --- | --- | --- |
| `AI Project` | http://127.0.0.1:4174/ | `npm start` |
| `Project` | http://127.0.0.1:4173/ | `npm start` |
| `E-Market website` | http://127.0.0.1:4175/ | `npm start` |
| `what sapp clone` | http://127.0.0.1:3000/ | `npm start` |

Use Node.js 24 or newer. In PowerShell, open a project's folder, install its dependencies, then start it:

```powershell
Set-Location "AI Project"
npm install
npm start
```

Repeat those commands in the folder of the app you want to run. The addresses above are local development URLs; they are not publicly hosted websites.

For safety, this repository excludes `.env` files, local SQLite databases, generated build output, and `node_modules`. Do not commit passwords, API keys, or real user data.
