# Testing

Jest (backend). Run from `backend/`:

```bash
npm test
```

Setup/fixtures under `backend/test/` (`app.ts`, `global-setup.ts`, `jest.setup.ts`, `test-db.ts`).

## Browser-based verification (E2E)

Jest here is API/unit-level, not a browser driver. When a change needs
verifying through the actual UI, Claude Code can drive a real Chrome session
via the Claude in Chrome extension: log in, click through a flow, read
console/network output, take screenshots. Ask for it explicitly ("open the app
in the browser and check X"); it's manual/on-demand, not part of the Jest
suite or CI.
