/**
 * Costume Management extensions entry point.
 *
 * Exposes this costume's gadgets through the CostumeExtensions mechanism
 * (loaded by ClosetExtensionLoader), replacing the old gadgets/*.ts
 * directory-scan convention.
 */
import type { CostumeExtensions } from '@minions/gadgets';
import { gadget as createCostumeGadget } from './gadgets/create-costume.ts';

export function getExtensions(): CostumeExtensions {
  return {
    gadgets: [{ gadget: createCostumeGadget, endpoints: ['henchery'] }],
  };
}
