import express, { type Express } from 'express';
import path from 'path';
import fs from 'fs';

export function isProductionBoot(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' || env.APP_ENV === 'production';
}

export function attachSpaFallback(app: Express, clientDistPath: string): boolean {
  if (!fs.existsSync(clientDistPath)) {
    return false;
  }
  app.use(express.static(clientDistPath));
  app.get('/*splat', (_req, res) => {
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
  return true;
}
