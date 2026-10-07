import { settings } from './core.js';
import { FirestoreStore } from './store.js';
import { GoogleDrive } from './drive.js';
import { createApp } from './app.js';
const config = settings();
const app = createApp({ config, store: new FirestoreStore(config), drive: new GoogleDrive(config) });
const server = app.listen(Number(process.env.PORT) || 8080, '0.0.0.0', () => console.log('Wedding Photos ready'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
