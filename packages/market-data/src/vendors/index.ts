import { twelveDataAdapter } from './twelvedata';
import type { VendorAdapter } from './types';

/** Registered vendors. Finnhub etc. can be added here as new adapters. */
export const VENDOR_ADAPTERS: Record<string, VendorAdapter> = {
  twelvedata: twelveDataAdapter,
};

export const SUPPORTED_VENDORS = Object.keys(VENDOR_ADAPTERS);
