import { LearningPlan, DocumentGenerationContext } from './types';
import { resolveLearningPlanAllocatedJP } from '../learningPlanService';

export interface ModulAjarProjection {
  isReady: boolean;
  error?: string;

  plan?: LearningPlan;

  resolvedTPs: Array<{
    id: string;
    code?: string;
    statement: string;
    materialScope?: string;
  }>;

  resolvedAllocatedJP?: number;

  jpResolutionSource:
    | 'EXPLICIT_PLAN'
    | 'LINKED_TIME_ALLOCATION'
    | 'UNRESOLVED';
}

export function buildModulAjarProjection(context: DocumentGenerationContext): ModulAjarProjection {
  const isBlankMode = context.documentMode === 'blank';

  if (isBlankMode) {
    return {
      isReady: true,
      resolvedTPs: [],
      resolvedAllocatedJP: undefined,
      jpResolutionSource: 'UNRESOLVED',
    };
  }

  const learningPlans = context.learningPlans || [];
  const activePlanId = context.activeLearningPlanId;

  let selectedPlan: LearningPlan | undefined;

  if (activePlanId) {
    const plan = learningPlans.find((p) => p.id === activePlanId);
    if (!plan) {
      return {
        isReady: false,
        error: `Rencana pembelajaran terpilih dengan ID "${activePlanId}" tidak ditemukan.`,
        resolvedTPs: [],
        jpResolutionSource: 'UNRESOLVED',
      };
    }
    if (plan.status !== 'SIAP') {
      return {
        isReady: false,
        error: `Rencana pembelajaran "${plan.topic || plan.id}" terpilih belum diubah statusnya menjadi SIAP.`,
        resolvedTPs: [],
        jpResolutionSource: 'UNRESOLVED',
      };
    }
    selectedPlan = plan;
  } else {
    const siapPlans = learningPlans.filter((p) => p.status === 'SIAP');
    if (siapPlans.length === 0) {
      return {
        isReady: false,
        error: 'Belum ada rencana pembelajaran (Modul Ajar) dengan status SIAP.',
        resolvedTPs: [],
        jpResolutionSource: 'UNRESOLVED',
      };
    }
    if (siapPlans.length > 1) {
      return {
        isReady: false,
        error: 'Terdapat lebih dari satu rencana pembelajaran (Modul Ajar) dengan status SIAP. Silakan pilih salah satu rencana secara eksplisit.',
        resolvedTPs: [],
        jpResolutionSource: 'UNRESOLVED',
      };
    }
    selectedPlan = siapPlans[0];
  }

  // Resolve Canonical Objectives (TPs)
  const resolvedTPs: Array<{
    id: string;
    code?: string;
    statement: string;
    materialScope?: string;
  }> = [];

  if (selectedPlan.tpIds && selectedPlan.tpIds.length > 0) {
    for (const id of selectedPlan.tpIds) {
      const tpItem = context.tp?.items?.find((item) => item.id === id);
      if (tpItem) {
        resolvedTPs.push({
          id: tpItem.id,
          code: tpItem.code,
          statement: tpItem.statement || tpItem.description || '',
          materialScope: tpItem.contentScope,
        });
      }
    }
  }

  // If resolvedTPs is empty, fallback to stored objectives as compatibility fallback
  if (resolvedTPs.length === 0 && selectedPlan.objectives) {
    const list = Array.isArray(selectedPlan.objectives) ? selectedPlan.objectives : [selectedPlan.objectives];
    for (const obj of list) {
      if (obj && typeof obj === 'object') {
        const objAny = obj as any;
        resolvedTPs.push({
          id: objAny.id || objAny.tpId || '',
          code: objAny.code,
          statement: objAny.statement || '',
          materialScope: objAny.materialScope,
        });
      } else if (typeof (obj as any) === 'string' && (obj as any).trim()) {
        resolvedTPs.push({
          id: '',
          statement: obj as any,
        });
      }
    }
  }

  // Resolve JP
  const jpRes = resolveLearningPlanAllocatedJP(selectedPlan, {
    atp: context.atp,
    timeAllocations: context.timeAllocations,
  });

  const sourceMapped = jpRes.source === 'CANONICAL_ATP' ? 'UNRESOLVED' : jpRes.source;

  return {
    isReady: true,
    plan: selectedPlan,
    resolvedTPs,
    resolvedAllocatedJP: jpRes.allocatedJP,
    jpResolutionSource: sourceMapped,
  };
}
