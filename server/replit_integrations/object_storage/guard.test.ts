import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { isObjectStorageConfigured, requireObjectStorage } from './guard';

const saved = process.env.PRIVATE_OBJECT_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.PRIVATE_OBJECT_DIR;
  else process.env.PRIVATE_OBJECT_DIR = saved;
});

function app() {
  const a = express();
  a.get('/x', requireObjectStorage, (_req, res) => res.json({ ok: true }));
  return a;
}

describe('object storage guard', () => {
  it('is configured only when PRIVATE_OBJECT_DIR is set', () => {
    expect(isObjectStorageConfigured({})).toBe(false);
    expect(isObjectStorageConfigured({ PRIVATE_OBJECT_DIR: '  ' })).toBe(false);
    expect(isObjectStorageConfigured({ PRIVATE_OBJECT_DIR: '/bucket/private' })).toBe(true);
  });

  it('503 "storage not configured" without PRIVATE_OBJECT_DIR', async () => {
    delete process.env.PRIVATE_OBJECT_DIR;
    const res = await request(app()).get('/x');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'storage not configured', code: 'STORAGE_NOT_CONFIGURED' });
  });

  it('passes through on Replit (PRIVATE_OBJECT_DIR set)', async () => {
    process.env.PRIVATE_OBJECT_DIR = '/bucket/private';
    expect((await request(app()).get('/x')).status).toBe(200);
  });
});
