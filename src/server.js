import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import hpp from 'hpp';
import session from 'express-session';
import sessionFileStore from 'session-file-store';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './utils/logger.js';

// Init DB
import './models/database.js';

// Routes
import authRoutes from './routes/auth.js';
import proxyRoutes from './routes/proxy.js';
import userRoutes from './routes/user.js';
import adminRoutes from './routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const FileStore = sessionFileStore(session);

// Trust proxy if we are behind one (e.g. Railway, Nginx)
app.set('trust proxy', 1);

// Security MW
app.use(helmet({ contentSecurityPolicy: false })); // Disabled CSP for inline scripts in generated HTML
app.use(cors());
app.use(hpp());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate Limiting
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.GLOBAL_RATE_LIMIT_MAX || '200'),
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

// Session
app.use(session({
  store: new FileStore({ path: path.join(__dirname, '../data/sessions'), retries: 0 }),
  secret: process.env.SESSION_SECRET || 'fallback_secret_must_change_in_prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7 // 1 week
  }
}));

// Static files
app.use(express.static(path.join(__dirname, '../public')));

// API Routes
app.use('/', authRoutes); // mounts login/register logic and HTML sending
app.use('/api/v1', proxyRoutes); // Note: The route in proxy.js specifically starts with /v1, so we mount at /api
app.use('/api/user', userRoutes);
app.use('/api/admin', adminRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: Date.now() }));

// Fallback logic for frontend
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '../public/dashboard.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '../public/admin.html')));

app.use((req, res) => res.status(404).sendFile(path.join(__dirname, '../public/404.html')));

app.use((err, req, res, next) => {
  logger.error('Unhandled Server Error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`VixProxy started on port ${PORT}`);
});
