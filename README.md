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

Repeat those commands in the folder of the app you want to run.
The addresses above are local development URLs; they are not publicly hosted websites.

For safety, this repository excludes `.env` files, local SQLite databases, generated build output, and `node_modules`.
Do not commit passwords, API keys, or real user data.

## GitHub Pages preview

The GitHub Pages workflow publishes the Artifi AI assistant from `AI Project/artifi.html` at [the project GitHub Pages URL](https://jonathandecker1333.github.io/cyber-security-website/). Chat requires your own Gemini API key in the browser. The static preview does not run the Node.js backends for E-Market or Salone Register.

## Project-only subtree branches

The monorepo keeps both projects on `main`; these branches contain only the named project, with that project's files at the branch root:

- [E-Market Website (`e-market-website`)](https://github.com/JonathanDecker1333/cyber-security-website/tree/e-market-website)
- [Salone Register (`project`)](https://github.com/JonathanDecker1333/cyber-security-website/tree/project)

## Deploy the complete applications

GitHub Pages can serve static files, but these apps need their Node.js backends and PostgreSQL databases. The root `render.yaml` describes two free Render web services:

| App | Render service | Expected free URL |
| --- | --- | --- |
| E-Market Website | `xd-market` | `https://xd-market.onrender.com` |
| Project (Salone Register) | `salone-register` | `https://salone-register.onrender.com` |

Render only assigns the public URLs after the services are created; a service name may need to change if it is already taken. Free services can sleep when idle, and their local files are temporary. Keep the databases on Supabase rather than storing data on Render.

To deploy:

1. Create a separate Supabase project for each app, so the two apps have separate database credentials and data.
2. In Render, choose **New → Blueprint**, connect this repository, and deploy its `main` branch. Render will read `render.yaml`.
3. For each service, set `DATABASE_URL` to that app's Supabase PostgreSQL connection string. Use the Supabase session pooler if the direct endpoint is unreachable from Render.
4. Set each `APP_ORIGIN` to that service's actual `https://…onrender.com` URL. For E-Market, also set a unique administrator `ADMIN_EMAIL` and strong `ADMIN_PASSWORD`.
5. Apply each app's database migrations as described in its folder README (`npm run migrate` in `E-Market website`; `npm run db:migrate` in `Project`). Salone Register's generated `SETUP_TOKEN` is needed for secure first-teacher setup; do not share it publicly.

Keep Supabase connection strings, administrator passwords, and setup tokens in Render's environment-variable settings, never in GitHub. Database migrations create the app schema; they do not import local SQLite database contents.
