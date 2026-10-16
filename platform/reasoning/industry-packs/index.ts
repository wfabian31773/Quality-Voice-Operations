import type { IndustryReasoningPack, IndustryVertical } from '../types';
import { hvacPack } from './hvac';
import { plumbingPack } from './plumbing';
import { dentalPack } from './dental';
import { medicalPack } from './medical';
import { propertyManagementPack } from './property-management';
import { legalPack } from './legal';
import { restaurantPack } from './restaurant';
import { realEstatePack } from './real-estate';
import { insurancePack } from './insurance';
import { salonPack } from './salon';

const INDUSTRY_PACKS: Map<IndustryVertical, IndustryReasoningPack> = new Map([
  ['hvac', hvacPack],
  ['plumbing', plumbingPack],
  ['dental', dentalPack],
  ['medical-after-hours', medicalPack],
  ['property-management', propertyManagementPack],
  ['legal', legalPack],
  ['restaurant', restaurantPack],
  ['real-estate', realEstatePack],
  ['insurance', insurancePack],
  ['salon', salonPack],
]);

export function getIndustryPack(vertical: string): IndustryReasoningPack | undefined {
  return INDUSTRY_PACKS.get(vertical as IndustryVertical);
}

export function getAllIndustryPacks(): IndustryReasoningPack[] {
  return Array.from(INDUSTRY_PACKS.values());
}

export function getIndustryVerticals(): IndustryVertical[] {
  return Array.from(INDUSTRY_PACKS.keys());
}

export {
  hvacPack,
  plumbingPack,
  dentalPack,
  medicalPack,
  propertyManagementPack,
  legalPack,
  restaurantPack,
  realEstatePack,
  insurancePack,
  salonPack,
};
