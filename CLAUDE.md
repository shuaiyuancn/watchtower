# Watchtower working instructions

## Ownership

Claude is the only coder on this repo and owns the work from change to production. Do not stop to ask for a review, a merge approval, or a deploy approval. For each change:

1. Branch from `origin/main`. Never commit to `main` directly.
2. Implement the change and run the tests listed under Commands.
3. Review your own diff before you merge. Look for correctness bugs, security problems in generated PowerShell, and anything that could leave a client stopped. Fix what you find and push.
4. Open a pull request that is ready for review, with a body that says what was tested and what was not.
5. Wait for both CI jobs (`backend` and `client`) to pass.
6. Squash-merge with `gh pr merge <n> --squash --delete-branch`.
7. Confirm the deploy is live, then report what you verified and what is still untested.

Ask first for anything destructive or hard to undo that falls outside this flow: deleting data or the Railway volume, rotating secrets, force-pushing, or running the installer or uninstaller on a real PC.

## Deploy

- Railway deploys the backend from `main` on every push. The live URL is `https://watchtower-production-3b1e.up.railway.app`.
- Check a backend deploy by fetching an endpoint the change touched, for example `/api/install.ps1`, and looking for the new behaviour.
- Every push to `main` also runs `release-client.yml`, which builds `watchtower.exe` and publishes it to GitHub Releases. Installed clients update themselves from that release within about 6 hours, so a merge to `main` ships the client to real devices even when only the backend changed.

## Commands

```bash
npm run test:backend        # Vitest, from the repo root
npm run build:backend       # backend and dashboard build, as CI runs it
cd client && cargo test     # Rust client tests (Windows)
```

## Installer scripts

The install and uninstall scripts are TypeScript template strings in `backend/src/routes/api.ts`. Inside them, double every backslash, escape backticks, and avoid PowerShell's `${var}` form because the template would interpolate it. After editing, request the script from a test server and parse it with `[System.Management.Automation.Language.Parser]::ParseInput` to catch syntax errors. Read the file as UTF-8, because the scripts contain emoji.

Any query value embedded in a script must be reduced to an allowlist of characters first, as `user` is.
