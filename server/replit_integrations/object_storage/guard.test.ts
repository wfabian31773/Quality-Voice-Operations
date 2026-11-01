import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { resetStorageAdapterForTests } from '../../../platform/storage';
import { isObjectStorageConfigured, requireObjectStorage } from './guard';

const saved = {
  PRIVATE_OBJECT_DIR: process.env.PRIVATE_OBJECT_DIR,
  OBJECT_STORAGE_PROVIDER: process.env.OBJECT_STORAGE_PROVIDER,
  OBJECT_STORAGE_LOCAL_DIR: process.env.OBJECT_STORAGE_LOCAL_DIR,
  S3_BUCKET: process.env.S3_BUCKET,
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetStorageAdapterForTests();
}

afterEach(restoreEnv);

function app() {
  const a = express();
  a.get('/x', requireObjectStorage, (_req, res) => res.json({ ok: true }));
  return a;
}

describe('object storage guard', () => {
  it('is configured for Replit, S3, or local disk', () => {
    expect(isObjectStorageConfigured({})).toBe(false);
    expect(isObjectStorageConfigured({ PRIVATE_OBJECT_DIR: '  ' })).toBe(false);
    expect(isObjectStorageConfigured({ PRIVATE_OBJECT_DIR: '/bucket/private' })).toBe(true);
    expect(isObjectStorageConfigured({ OBJECT_STORAGE_PROVIDER: 'local' })).toBe(true);
    expect(
      isObjectStorageConfigured({
        OBJECT_STORAGE_PROVIDER: 's3',
        S3_BUCKET: 'qvo',
        S3_ACCESS_KEY_ID: 'id',
        S3_SECRET_ACCESS_KEY: 'secret',
      }),
    ).toBe(true);
    expect(isObjectStorageConfigured({ OBJECT_STORAGE_PROVIDER: 's3', S3_BUCKET: 'qvo' })).toBe(false);
  });

  it('503 "storage not configured" without a backend', async () => {
    delete process.env.PRIVATE_OBJECT_DIR;
    delete process.env.OBJECT_STORAGE_PROVIDER;
    delete process.env.OBJECT_STORAGE_LOCAL_DIR;
    delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
    const res = await request(app()).get('/x');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'storage not configured', code: 'STORAGE_NOT_CONFIGURED' });
  });

  it('passes through on Replit (PRIVATE_OBJECT_DIR set)', async () => {
    process.env.PRIVATE_OBJECT_DIR = '/bucket/private';
    expect((await request(app()).get('/x')).status).toBe(200);
  });

  it('passes through when local disk is selected', async () => {
    delete process.env.PRIVATE_OBJECT_DIR;
    process.env.OBJECT_STORAGE_PROVIDER = 'local';
    expect((await request(app()).get('/x')).status).toBe(200);
  });
});
