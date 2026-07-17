# Changesets

This directory contains [changesets](https://github.com/changesets/changesets) for versioning and changelog generation.

- `config.json` — changeset tool configuration
- `*.md` — pending changeset files (one per feature/bugfix)

## Workflow

1. Run `npx changeset` to create a new changeset
2. Edit the generated `.md` file to describe your change
3. Commit the changeset alongside your code
4. The release workflow will consume all pending changesets on merge to `main`
