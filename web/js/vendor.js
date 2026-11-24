/**
 * Bundled UI dependencies (icons, fonts, QR codes).
 * Bundling them instead of loading from CDNs keeps the PWA working offline
 * and pins exact versions.
 */

import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import QRCode from 'qrcode';

import {
  createIcons,
  Activity, ArrowDownLeft, ArrowUpRight, Bell, Blocks, Bot, Brain, Check, ChevronRight,
  Clock, Coins, Copy, Cpu, Database, Download, Eye, EyeOff, FileText, Fingerprint, Flame,
  FlaskConical, Gem, Globe, Hexagon, Info, Key, KeyRound, Layers, Lock, LogOut, Plus,
  QrCode, Radio, Search, Send, Settings, ShieldCheck, Sparkles, Tablet, Trash2,
  TriangleAlert, User, UserPlus, Users, Wallet, X, Zap,
} from 'lucide';

const icons = {
  Activity, ArrowDownLeft, ArrowUpRight, Bell, Blocks, Bot, Brain, Check, ChevronRight,
  Clock, Coins, Copy, Cpu, Database, Download, Eye, EyeOff, FileText, Fingerprint, Flame,
  FlaskConical, Gem, Globe, Hexagon, Info, Key, KeyRound, Layers, Lock, LogOut, Plus,
  QrCode, Radio, Search, Send, Settings, ShieldCheck, Sparkles, Tablet, Trash2,
  TriangleAlert, User, UserPlus, Users, Wallet, X, Zap,
  AlertTriangle: TriangleAlert, // older name used in markup
};

// Same API the app already calls: window.lucide.createIcons()
window.lucide = {
  createIcons: (opts = {}) => createIcons({ icons, attrs: { 'stroke-width': 1.75 }, ...opts }),
};

window.MziyaQR = QRCode;
