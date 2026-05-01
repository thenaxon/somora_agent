// Entry-point for the Ink-based somora CLI.
//   npm run dev:cli            — this file
//   npm run dev:cli:legacy     — old readline CLI (will be removed once
//                                Phase C ships)

import { render } from 'ink';
import { App } from './app.tsx';

const port = Number(process.env.SOMORA_PORT ?? 18737);
const host = process.env.SOMORA_HOST ?? '127.0.0.1';
const base = `http://${host}:${port}`;

render(<App base={base} initialAgent="hans" initialSession="main" />);
