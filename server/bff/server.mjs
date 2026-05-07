import { createBffApp } from './app.mjs';
import { resolveProjectId } from './firestore.mjs';

const port = Number.parseInt(String(process.env.PORT || process.env.BFF_PORT || '8787'), 10);
const projectId = resolveProjectId();
const app = createBffApp({ projectId });

app.listen(port, '127.0.0.1', () => {
  console.log(`[submitMYSC BFF] listening on http://127.0.0.1:${port}`);
});
