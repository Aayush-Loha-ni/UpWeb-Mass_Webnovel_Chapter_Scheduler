# Contributing

Thanks for your interest in contributing to Webnovel Automation!

## How to Contribute

1. **Fork** the repository
2. **Create a branch** (`git checkout -b feature/your-feature`)
3. **Make your changes**
4. **Run tests** (`npm test`)
5. **Run lint** (`npm run lint`)
6. **Commit** using conventional commit messages
7. **Push** and open a Pull Request

## Development Setup

```bash
git clone <your-fork>
cd webnovel-automation
npm install
npx playwright install chromium --with-deps
npm run dev
```

## Code Style

- TypeScript with strict mode
- Follow existing patterns in the codebase
- No unrequested abstractions — prefer simple solutions
- Add tests for new features

## Pull Request Guidelines

- Keep PRs focused on a single concern
- Include before/after screenshots for UI changes
- Update relevant documentation
- Ensure CI passes

## Report Bugs

Open an issue with:
- Steps to reproduce
- Expected vs actual behavior
- Screenshots if applicable
- Environment (OS, app version)
