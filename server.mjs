import express from 'express';
import { fileURLToPath } from 'node:url';
import { mountRsvp } from './rsvp.mjs';

const app = express();
const port = Number(process.env.PORT ?? 3000);
const publicDirectory = fileURLToPath(new URL('./public/', import.meta.url));

app.disable('x-powered-by');
mountRsvp(app);
app.use(express.static(publicDirectory));
app.listen(port, '0.0.0.0', () => {
  console.log(`Invitation listening on port ${port}`);
});
