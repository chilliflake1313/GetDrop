const DEFAULT_BACKEND_HTTP = 'https://getdrop-3.onrender.com';
const DEFAULT_BACKEND_WS = 'wss://getdrop-3.onrender.com';

function normalizeHttpUrl(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    return DEFAULT_BACKEND_HTTP;
  }

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }

  if (trimmed.startsWith('ws://')) {
    return `http://${trimmed.slice(5)}`;
  }

  if (trimmed.startsWith('wss://')) {
    return `https://${trimmed.slice(6)}`;
  }

  return `https://${trimmed}`;
}

function normalizeWsUrl(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    return DEFAULT_BACKEND_WS;
  }

  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) {
    return trimmed;
  }

  if (trimmed.startsWith('http://')) {
    return `ws://${trimmed.slice(7)}`;
  }

  if (trimmed.startsWith('https://')) {
    return `wss://${trimmed.slice(8)}`;
  }

  return `wss://${trimmed}`;
}

const apiFromEnv = process.env.REACT_APP_API || '';
const wsFromEnv = process.env.REACT_APP_WS || '';

export const API_BASE_URL = normalizeHttpUrl(apiFromEnv || wsFromEnv);
export const WS_URL = normalizeWsUrl(wsFromEnv || apiFromEnv);
