# chatsync

A small CLI that copies Claude desktop Code-tab sidebar entries between the accounts you are signed in with on one Mac, so every account lists every chat. It copies sidebar entries only, never conversations, and backs up before every write.

Usage, workflow and safety notes are in the [package README](packages/chatsync/README.md). Design notes are in [docs/specs](docs/specs/2026-10-22-chatsync-design.md).

## Development

Nx and yarn 4 workspace; the package is `packages/chatsync`.

```sh
yarn                        # install
yarn nx test chatsync       # run the tests
yarn nx build chatsync      # build to packages/chatsync/dist
node packages/chatsync/dist/index.js status
```

## License

MIT
