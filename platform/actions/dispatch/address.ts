import type { DispatchAddress } from './schemas';

/** Fold a free-text address so admin-created jobs can match action intake. */
export function foldAddressText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Canonical form used for duplicate detection and the advisory lock.
 * Includes the unit so Apt 2 and Apt 3 at the same street are distinct.
 */
export function normalizeAddress(address: DispatchAddress): string {
  return [address.line1, address.unit ?? '', address.city, address.region, address.postal].map(foldAddressText).join('|');
}

/** Spoken and stored address, unit included when present. */
export function formatAddress(address: DispatchAddress): string {
  const street = address.unit ? `${address.line1}, ${address.unit}` : address.line1;
  return `${street}, ${address.city}, ${address.region} ${address.postal}`;
}
