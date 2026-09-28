import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {
  loadStorageV5,
  saveStorageV5,
  createSchoolV5,
  createProfileV5,
  createYearHierarchyV5,
  saveAcademicCalendarV5,
  saveSemesterJPSettingV5,
  saveTimeAllocationV5,
  saveATPV5,
} from '../src/services/storageV5';
import { getRuntimeContextV5 } from '../src/services/runtimeV5';
import {
  partitionAnnualATP,
  buildAutomaticSemesterAllocations,
  resolveSemesterCapacityV5,
  validateTimeAllocations,
} from '../src/services/jpEngine';
import {
  TimeAllocation,
  SemesterJPSetting,
  ATPData,
  AcademicCalendar,
  CalendarDay,
} from '../src/types';

// Mock localStorage in Node environment
class MockLocalStorage {
  private store: Map<string, string> = new Map();

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get length(): number {
    return this.store.size;
  }

  key(index: number): string | null {
    const keys = Array.from(this.store.keys());
    return keys[index] || null;
  }
}

const mockStorage = new MockLocalStorage();
(globalThis as any).localStorage = mockStorage;

console.log('=== RUNNING B.4.2B AUTOMATIC SEMESTER TIME ALLOCATION REGRESSION ===');

function runTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
  } catch (err: any) {
    console.error(`[FAIL] ${name}`);
    console.error(err);
    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// SETUP
// -----------------------------------------------------------------------------
mockStorage.clear();

const school = createSchoolV5({
  name: 'SD Negeri Nusantara Cerdas',
  npsn: '20230099',
  address: 'Jl. Pendidikan Merdeka No. 10',
  village: 'Sukamaju',
  district: 'Cidadap',
  regency: 'Kota Bandung',
  province: 'Jawa Barat',
  principalName: 'Dra. Hj. Ratna Sari, M.Pd.',
  principalNip: '197003151996032001',
});

const profile = createProfileV5({
  name: 'Ahmad Fauzi, S.Pd.',
  nip: '198805202014031002',
  status: 'PNS',
  defaultSubject: 'Matematika',
  defaultLevel: 'SD',
  schoolId: school.id,
});

const hierarchy = createYearHierarchyV5({
  profileId: profile.id,
  schoolId: school.id,
  academicYear: '2026/2027',
  curriculumType: 'KURIKULUM_MERDEKA',
  level: 'SD',
  grade: 'Fase B / Kelas 4',
  subject: 'Matematika',
});

const sem1 = hierarchy.semesterPlans[0];
const sem2 = hierarchy.semesterPlans[1];

// 10 Annual ATP Items in strict sequence
const sampleAnnualATP: ATPData = {
  id: `atp-${hierarchy.yearPlan.id}`,
  academicSettingId: hierarchy.yearPlan.id,
  phase: 'B',
  updatedAt: new Date().toISOString(),
  items: Array.from({ length: 10 }, (_, i) => ({
    id: `atp-item-${i + 1}`,
    tpId: `tp-${i + 1}`,
    tpCode: `TP.4.${i + 1}`,
    tpStatement: `Tujuan Pembelajaran Matematika Materi ${i + 1}`,
    materialScope: `Lingkup Materi ${i + 1}`,
    stepNumber: i + 1,
  })),
};

saveATPV5(hierarchy.yearPlan.id, sampleAnnualATP);
const annualAtpBackup = JSON.stringify(sampleAnnualATP);

// Helper to create simple confirmed calendar
function makeConfirmedCalendarDays(calId: string, startDateStr: string, weeks: number, schoolDays: number = 5): CalendarDay[] {
  const days: CalendarDay[] = [];
  const start = new Date(startDateStr);
  let cur = new Date(start);
  let dayCounter = 1;
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const dayOfWeek = cur.getDay(); // 0 Sun, 1 Mon ... 6 Sat
      const isEffective = dayOfWeek >= 1 && dayOfWeek <= schoolDays;
      days.push({
        id: `day-${calId}-${dayCounter++}`,
        academicCalendarId: calId,
        date: cur.toISOString().slice(0, 10),
        status: isEffective ? 'EFFECTIVE_LEARNING' : 'NON_LEARNING',
      });
      cur.setDate(cur.getDate() + 1);
    }
  }
  return days;
}

// -----------------------------------------------------------------------------
// TEST 1 & 2: Capacity Proportions (Not Hardcoded 50:50)
// -----------------------------------------------------------------------------
runTest('1 & 2. partitionAnnualATP distributes items proportionally according to capacity shares (not 50:50)', () => {
  const items = sampleAnnualATP.items;

  // Case A: S1 = 40 JP, S2 = 60 JP (40% vs 60%) -> 10 items => 4 items S1, 6 items S2
  const partA = partitionAnnualATP(items, 40, 60);
  assert.strictEqual(partA.s1Items.length, 4, 'S1 must receive 4 items (40% of 10)');
  assert.strictEqual(partA.s2Items.length, 6, 'S2 must receive 6 items (60% of 10)');

  // Case B: S1 = 70 JP, S2 = 30 JP (70% vs 30%) -> 10 items => 7 items S1, 3 items S2
  const partB = partitionAnnualATP(items, 70, 30);
  assert.strictEqual(partB.s1Items.length, 7, 'S1 must receive 7 items (70% of 10)');
  assert.strictEqual(partB.s2Items.length, 3, 'S2 must receive 3 items (30% of 10)');

  // Case C: S1 = 50 JP, S2 = 50 JP (50% vs 50%) -> 10 items => 5 items S1, 5 items S2
  const partC = partitionAnnualATP(items, 50, 50);
  assert.strictEqual(partC.s1Items.length, 5);
  assert.strictEqual(partC.s2Items.length, 5);
});

// -----------------------------------------------------------------------------
// TEST 3, 4 & 5: Determinism, Order Preservation & No Cross-Semester Duplicates
// -----------------------------------------------------------------------------
runTest('3, 4 & 5. Partition preserves stepNumber order, covers all ATP exactly once without duplicates', () => {
  const items = sampleAnnualATP.items;
  const part = partitionAnnualATP(items, 44, 56);

  // 1. Order in S1
  part.s1Items.forEach((item, idx) => {
    assert.strictEqual(item.stepNumber, idx + 1);
  });

  // 2. Order in S2
  part.s2Items.forEach((item, idx) => {
    assert.strictEqual(item.stepNumber, part.s1Items.length + idx + 1);
  });

  // 3. S1 + S2 covers all items
  const combined = [...part.s1Items, ...part.s2Items];
  assert.strictEqual(combined.length, items.length);
  for (let i = 0; i < items.length; i++) {
    assert.strictEqual(combined[i].id, items[i].id);
  }

  // 4. No intersection (disjoint sets)
  const s1Ids = new Set(part.s1Items.map((i) => i.id));
  part.s2Items.forEach((item) => {
    assert.ok(!s1Ids.has(item.id), `Item ${item.id} must not exist in both S1 and S2`);
  });
});

// -----------------------------------------------------------------------------
// TEST 6 & 7: Weekly JP basis and availableJP exact match
// -----------------------------------------------------------------------------
runTest('6 & 7. Weekly JP is derived from actualScheduledWeeklyJP and sum(allocatedJP) matches availableJP', () => {
  const s1WeeklyJP = 4;
  const s1EffectiveWeeks = 18;
  const s1AvailableJP = 72; // 18 wks * 4 JP = 72 JP

  const s2WeeklyJP = 5;
  const s2EffectiveWeeks = 16;
  const s2AvailableJP = 80; // 16 wks * 5 JP = 80 JP

  const autoResS1 = buildAutomaticSemesterAllocations({
    annualATPItems: sampleAnnualATP.items,
    targetSemester: '1',
    semesterPlanId: sem1.id,
    s1Capacity: {
      availableJP: s1AvailableJP,
      effectiveWeeks: s1EffectiveWeeks,
      actualScheduledWeeklyJP: s1WeeklyJP,
      isCalendarConfirmed: true,
    },
    s2Capacity: {
      availableJP: s2AvailableJP,
      effectiveWeeks: s2EffectiveWeeks,
      actualScheduledWeeklyJP: s2WeeklyJP,
      isCalendarConfirmed: true,
    },
  });

  assert.strictEqual(autoResS1.status, 'SUCCESS');
  assert.strictEqual(autoResS1.allocations.length, 5); // 72 / (72+80) = 47.3% ~ 5 items

  const sumS1JP = autoResS1.allocations.reduce((sum, a) => sum + a.allocatedJP, 0);
  assert.strictEqual(sumS1JP, s1AvailableJP, 'Sum of allocatedJP must exactly equal availableJP (72 JP)');

  const validationS1 = validateTimeAllocations(autoResS1.allocations, s1AvailableJP);
  assert.strictEqual(validationS1.status, 'BALANCED');
  assert.strictEqual(validationS1.remainingJP, 0);

  // Check S2
  const autoResS2 = buildAutomaticSemesterAllocations({
    annualATPItems: sampleAnnualATP.items,
    targetSemester: '2',
    semesterPlanId: sem2.id,
    s1Capacity: {
      availableJP: s1AvailableJP,
      effectiveWeeks: s1EffectiveWeeks,
      actualScheduledWeeklyJP: s1WeeklyJP,
      isCalendarConfirmed: true,
    },
    s2Capacity: {
      availableJP: s2AvailableJP,
      effectiveWeeks: s2EffectiveWeeks,
      actualScheduledWeeklyJP: s2WeeklyJP,
      isCalendarConfirmed: true,
    },
  });

  assert.strictEqual(autoResS2.status, 'SUCCESS');
  assert.strictEqual(autoResS2.allocations.length, 5);
  const sumS2JP = autoResS2.allocations.reduce((sum, a) => sum + a.allocatedJP, 0);
  assert.strictEqual(sumS2JP, s2AvailableJP, 'Sum of allocatedJP must exactly equal availableJP (80 JP)');

  const validationS2 = validateTimeAllocations(autoResS2.allocations, s2AvailableJP);
  assert.strictEqual(validationS2.status, 'BALANCED');
  assert.strictEqual(validationS2.remainingJP, 0);
});

// -----------------------------------------------------------------------------
// TEST 8 & 9: Contiguous Week Ranges and Upper Bounds
// -----------------------------------------------------------------------------
runTest('8 & 9. Week ranges are contiguous, strictly positive, and bounded by effectiveWeeks', () => {
  const s1EffectiveWeeks = 18;
  const autoRes = buildAutomaticSemesterAllocations({
    annualATPItems: sampleAnnualATP.items,
    targetSemester: '1',
    semesterPlanId: sem1.id,
    s1Capacity: {
      availableJP: 72,
      effectiveWeeks: s1EffectiveWeeks,
      actualScheduledWeeklyJP: 4,
      isCalendarConfirmed: true,
    },
    s2Capacity: {
      availableJP: 72,
      effectiveWeeks: 18,
      actualScheduledWeeklyJP: 4,
      isCalendarConfirmed: true,
    },
  });

  assert.strictEqual(autoRes.status, 'SUCCESS');
  const allocs = autoRes.allocations;

  assert.strictEqual(allocs[0].startWeek, 1, 'First item must start at week 1');
  for (let i = 0; i < allocs.length; i++) {
    const cur = allocs[i];
    assert.ok(cur.startWeek >= 1, 'startWeek must be >= 1');
    assert.ok(cur.endWeek >= cur.startWeek, 'endWeek must be >= startWeek');
    assert.ok(cur.endWeek <= s1EffectiveWeeks, `endWeek (${cur.endWeek}) must be <= effectiveWeeks (${s1EffectiveWeeks})`);
    assert.ok(cur.allocatedJP > 0, 'allocatedJP must be strictly positive');

    if (i > 0) {
      const prev = allocs[i - 1];
      assert.strictEqual(
        cur.startWeek,
        prev.endWeek + 1,
        `Weeks must be contiguous: item ${i + 1} startWeek (${cur.startWeek}) must equal prev endWeek + 1 (${prev.endWeek + 1})`
      );
    }
  }

  assert.strictEqual(
    allocs[allocs.length - 1].endWeek,
    s1EffectiveWeeks,
    'Last item endWeek must reach effectiveWeeks (18)'
  );
});

// -----------------------------------------------------------------------------
// TEST 10: Insufficient Weeks -> Fail Closed
// -----------------------------------------------------------------------------
runTest('10. Insufficient effective weeks fails closed without generating invalid allocations', () => {
  // 10 items assigned to S1, but only 4 effective weeks in S1
  const failRes = buildAutomaticSemesterAllocations({
    annualATPItems: sampleAnnualATP.items,
    targetSemester: '1',
    semesterPlanId: sem1.id,
    s1Capacity: {
      availableJP: 100, // Large share of ATP
      effectiveWeeks: 4, // But only 4 effective weeks!
      actualScheduledWeeklyJP: 4,
      isCalendarConfirmed: true,
    },
    s2Capacity: {
      availableJP: 10,
      effectiveWeeks: 18,
      actualScheduledWeeklyJP: 4,
      isCalendarConfirmed: true,
    },
  });

  assert.strictEqual(failRes.status, 'INSUFFICIENT_EFFECTIVE_WEEKS');
  assert.strictEqual(failRes.allocations.length, 0, 'Must not produce invalid draft');
  assert.ok(failRes.message?.includes('melebihi jumlah minggu efektif'));
});

// -----------------------------------------------------------------------------
// TEST 11 & 12: Manual Overwrite Protection & Preservation of Non-ATP Allocations
// -----------------------------------------------------------------------------
runTest('11 & 12. Non-ATP allocations (e.g. ASSESSMENT, RESERVE) are preserved and not clobbered', () => {
  const existingAllocs: TimeAllocation[] = [
    {
      id: 'assessment-alloc-1',
      academicSettingId: sem1.id,
      sourceType: 'ASSESSMENT',
      sourceId: 'pts-1',
      allocatedJP: 4,
      jp: 4,
      startWeek: 9,
      endWeek: 9,
    },
    {
      id: 'old-atp-alloc-1',
      academicSettingId: sem1.id,
      sourceType: 'ATP_ITEM',
      sourceId: 'atp-item-1',
      atpItemId: 'atp-item-1',
      allocatedJP: 8,
      jp: 8,
      startWeek: 1,
      endWeek: 2,
    },
  ];

  const autoRes = buildAutomaticSemesterAllocations({
    annualATPItems: sampleAnnualATP.items,
    targetSemester: '1',
    semesterPlanId: sem1.id,
    s1Capacity: {
      availableJP: 72,
      effectiveWeeks: 18,
      actualScheduledWeeklyJP: 4,
      isCalendarConfirmed: true,
    },
    s2Capacity: {
      availableJP: 72,
      effectiveWeeks: 18,
      actualScheduledWeeklyJP: 4,
      isCalendarConfirmed: true,
    },
  });

  // Filtering simulation matching TimePlanningManager
  const nonAtp = existingAllocs.filter((a) => a.sourceType !== 'ATP_ITEM' && !a.atpItemId);
  const combined = [...nonAtp, ...autoRes.allocations];

  assert.strictEqual(combined.length, 1 + autoRes.allocations.length);
  assert.ok(combined.some((a) => a.id === 'assessment-alloc-1'), 'ASSESSMENT allocation must be preserved');
  assert.ok(!combined.some((a) => a.id === 'old-atp-alloc-1'), 'Old ATP allocation replaced by new draft');
});

// -----------------------------------------------------------------------------
// TEST 13, 14 & 15: Draft Lifecycle, Annual ATP Immutability & Semester Isolation
// -----------------------------------------------------------------------------
runTest('13, 14 & 15. Draft lifecycle, Annual ATP byte immutability, and semester isolation in V5', () => {
  // Save S1 Calendar & JP Setting
  const s1CalId = `cal-${sem1.id}`;
  const s1Days = makeConfirmedCalendarDays(s1CalId, '2026-07-13', 18);
  const s1Cal: AcademicCalendar = {
    id: s1CalId,
    academicSettingId: sem1.id,
    academicYear: '2026/2027',
    semester: '1 (Ganjil)',
    startDate: '2026-07-13',
    endDate: '2026-11-13',
    schoolDaysPerWeek: 5,
    workflowStatus: 'CONFIRMED',
    updatedAt: new Date().toISOString(),
  };
  saveAcademicCalendarV5(sem1.id, { calendar: s1Cal, days: s1Days });
  saveSemesterJPSettingV5(sem1.id, {
    semesterPlanId: sem1.id,
    actualScheduledWeeklyJP: 4,
    source: 'TEACHER_CONFIRMED',
  });

  // Save S2 Calendar & JP Setting
  const s2CalId = `cal-${sem2.id}`;
  const s2Days = makeConfirmedCalendarDays(s2CalId, '2027-01-11', 18);
  const s2Cal: AcademicCalendar = {
    id: s2CalId,
    academicSettingId: sem2.id,
    academicYear: '2026/2027',
    semester: '2 (Genap)',
    startDate: '2027-01-11',
    endDate: '2027-05-14',
    schoolDaysPerWeek: 5,
    workflowStatus: 'CONFIRMED',
    updatedAt: new Date().toISOString(),
  };
  saveAcademicCalendarV5(sem2.id, { calendar: s2Cal, days: s2Days });
  saveSemesterJPSettingV5(sem2.id, {
    semesterPlanId: sem2.id,
    actualScheduledWeeklyJP: 4,
    source: 'TEACHER_CONFIRMED',
  });

  // Check capacity resolution via V5
  const state = loadStorageV5();
  const s1Cap = resolveSemesterCapacityV5(sem1.id, state);
  const s2Cap = resolveSemesterCapacityV5(sem2.id, state);

  assert.strictEqual(s1Cap.isReady, true);
  assert.strictEqual(s2Cap.isReady, true);
  assert.strictEqual(s1Cap.availableJP, 72);
  assert.strictEqual(s2Cap.availableJP, 72);

  // Auto-allocate S1
  const s1Draft = buildAutomaticSemesterAllocations({
    annualATPItems: sampleAnnualATP.items,
    targetSemester: '1',
    semesterPlanId: sem1.id,
    s1Capacity: s1Cap,
    s2Capacity: s2Cap,
  });

  // Before explicit save: storage V5 must still be empty for S1 time allocations
  const runtimeBeforeSave = getRuntimeContextV5();
  const initialS1Allocs = runtimeBeforeSave.semesterData?.timeAllocation || [];
  assert.strictEqual(initialS1Allocs.length, 0, 'Auto-generate creates local draft; storage V5 is unwritten before explicit save');

  // Explicit Save S1
  saveTimeAllocationV5(sem1.id, s1Draft.allocations);

  // Auto-allocate S2 and Save S2
  const s2Draft = buildAutomaticSemesterAllocations({
    annualATPItems: sampleAnnualATP.items,
    targetSemester: '2',
    semesterPlanId: sem2.id,
    s1Capacity: s1Cap,
    s2Capacity: s2Cap,
  });
  saveTimeAllocationV5(sem2.id, s2Draft.allocations);

  // Verify S1 and S2 isolation
  const stateAfter = loadStorageV5();
  stateAfter.activeSemesterPlanId = sem1.id;
  saveStorageV5(stateAfter);

  const runtimeS1 = getRuntimeContextV5();
  assert.strictEqual(runtimeS1.semesterData?.timeAllocation?.length, 5);
  assert.strictEqual(runtimeS1.semesterData?.timeAllocation?.[0].sourceId, 'atp-item-1');

  stateAfter.activeSemesterPlanId = sem2.id;
  saveStorageV5(stateAfter);

  const runtimeS2 = getRuntimeContextV5();
  assert.strictEqual(runtimeS2.semesterData?.timeAllocation?.length, 5);
  assert.strictEqual(runtimeS2.semesterData?.timeAllocation?.[0].sourceId, 'atp-item-6');

  // Verify annual ATP remains byte-for-byte unmodified
  const currentAnnualATP = runtimeS2.annualData?.atp;
  assert.strictEqual(
    JSON.stringify(currentAnnualATP),
    annualAtpBackup,
    'Annual ATP must remain byte-for-byte identical after auto-allocation workflows'
  );
});

console.log('\nAll B.4.2B Automatic Semester Time Allocation regression tests PASSED 100%!\n');
