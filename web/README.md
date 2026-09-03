# smith web

Four screens: sign in, projects, a project's reviews, one review. Plus settings for leads.

Dark only — one palette in `app/globals.css`, no light variant and no theme switcher.

## State model

There isn't one, and that is deliberate.

- Every page is a Server Component. It calls the API through `lib/api.ts`, which forwards the
  session cookie from `next/headers`.
- Every mutation is a Server Action in `app/actions.ts`. It calls the API and then
  `revalidatePath`, so the page re-renders from the database.
- The browser never sees the API, never holds a token, and never caches anything that could
  disagree with the server. No react-query, no store, no context.

The only client components are the four forms that need pending state (`useActionState`).

## Dependencies

`next`, `react`, `react-dom`, `tailwindcss`, `typescript`. That is the whole list. The five UI
primitives in `components/ui.tsx` are ~70 lines and replace a component library plus its four
transitive dependencies.

## Run

```bash
npm install
SMITH_API_URL=http://localhost:8000 npm run dev     # → http://localhost:3100
```

Needs Node ≥ 20.9 (Next 16). `SMITH_API_URL` points at the FastAPI process; it is read on the
server only, never shipped to the browser.

## Permissions

The UI hides what a developer cannot do, but that is cosmetic — the API enforces every rule on its
own. A developer who guesses the settings URL gets a 403 from the server, not a broken page.
