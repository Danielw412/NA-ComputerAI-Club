# Contributing

Thanks for helping! Any club member can suggest a change, and small ones count:
fixing a typo, making a README clearer, or adding a scenario to Exit Code.

If you haven't set up your computer yet, start with
[Getting started](docs/GETTING_STARTED.md).

## Your first change, step by step

1. **Get the latest code.** In the repository folder, run:

   ```bash
   git checkout main
   git pull
   ```

2. **Make a branch.** A branch is your own copy to work on. Name it after what
   you're doing:

   ```bash
   git checkout -b fix-readme-typo
   ```

3. **Make your change** in VS Code and save it.

4. **Test it.** Run the project and check that your change works. For the
   website projects, also run the automatic tests from inside the project
   folder:

   ```bash
   npm test
   npm run build
   ```

5. **Commit it.** This saves a snapshot with a short message about what changed:

   ```bash
   git add .
   git commit -m "Fix a typo in the 67 SPEED README"
   ```

6. **Push it** to GitHub:

   ```bash
   git push -u origin fix-readme-typo
   ```

7. **Open a pull request.** GitHub shows a **Compare & pull request** button
   after you push. Say what you changed and how you tested it.

A club lead will review it. They might ask for changes. That's normal, so just
make them on the same branch, commit, and push again.

## Automatic checks

When a pull request changes `67speed/` or `death-by-ai/`, GitHub runs that
project's tests and build. You'll see a green check or a red X on the pull
request. If it's red, click **Details** to see what failed. The checks are
defined in [`.github/workflows/`](.github/workflows/).

## Project rules

- **67 SPEED:** keep camera processing on the player's device, keep keyboard
  and mobile support working, and update the Privacy Notice if what the game
  stores changes.
- **Exit Code:** never commit `.dev.vars`. It holds passwords and API keys.
- **Everywhere:** never commit passwords, API keys, or `.env` files, and update
  the README when you change how something works.

## Adding a new project

1. Make a new folder at the top level with a short, lowercase name, like
   `my-project/`.
2. Add a `README.md` in it that says what the project is, how to run it, and
   where the important code lives. The other project READMEs are good examples.
3. Add a row for it to the **Projects** table and a short section in the main
   [README](README.md).
