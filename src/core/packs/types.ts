import type { ElementDescriptor, UserAction } from '@/shared/protocol';

export interface PackStep {
  title: string;
  detail?: string;
  expectedUserAction: UserAction;
  target: ElementDescriptor;
}

export interface PackFlow {
  id: string;
  goalAliases: string[];
  steps: PackStep[];
}

export interface GuidePack {
  name: string;
  version: number;
  displayName: string;
  description: string;
  match: { domains: string[] };
  siteNotes?: string;
  flows: PackFlow[];
}
