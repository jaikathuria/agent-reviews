# Contributing to Agent Review

## Development Setup

```bash
git clone https://github.com/jaikathuria/agent-reviews.git
cd agent-reviews
npm install
npm run compile
```

## Running & Testing

1. Open the project in VSCode
2. Press **F5** to launch the Extension Development Host
3. In the new window, open a project with a `.reviews/` directory containing review JSON files
4. The extension activates and displays inline comments

Use `npm run watch` for incremental compilation during development.

## Making Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-change`)
3. Make your changes and verify they compile (`npm run compile`)
4. Test manually in the Extension Development Host (F5)
5. Commit with a descriptive message
6. Push to your fork and open a Pull Request

## Reporting Issues

Use [GitHub Issues](https://github.com/jaikathuria/agent-reviews/issues) to report bugs or request features. For bugs, include:

- Steps to reproduce
- Expected vs actual behavior
- Your VSCode version and OS
- A sample review JSON file if relevant

## Code Style

- TypeScript strict mode is enabled
- Follow existing patterns in the codebase
- Keep changes focused — one feature or fix per PR
