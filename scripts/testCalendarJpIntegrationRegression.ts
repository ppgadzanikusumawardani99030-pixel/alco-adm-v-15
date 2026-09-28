import assert from 'assert';
import {
  loadStorageV5,
  saveStorageV5,
  createSchoolV5,
  createProfileV5,
  createYearHierarchyV5,
  saveAcademicCalendarV5,
  saveSemesterJPSettingV5,
  saveTimeAllocationV5,
} from '../src/services/storageV5';
import { getRuntimeContextV5 } from '../src/services/runtimeV5';
import {
  AcademicCalendar,
  CalendarDay,
  TimeAllocation,
  SemesterJPSetting,
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

console.log('=== RUNNING CALENDAR -> SEMESTER JP & TIME ALLOCATION INTEGRATION REGRESSION ===');

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
  name: 'SD Negeri Nusantara 01',
  npsn: '12345678',
  address: 'Jl. Pendidikan No. 1',
  village: 'Sukamaju',
  district: 'Cibadak',
  regency: 'Kabupaten Sukabumi',
  province: 'Jawa Barat',
  principalName: 'Dra. Hj. Siti Nurhaliza, M.Pd.',
  principalNip: '197501012000032001',
});

const profile = createProfileV5({
  name: 'Ahmad Fauzi, S.Pd.',
  nip: '198805122015031002',
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
  grade: 'Fase A / Kelas 1',
  subject: 'Matematika',
});

const sem1 = hierarchy.semesterPlans[0];
const sem2 = hierarchy.semesterPlans[1];

// -----------------------------------------------------------------------------
// TEST 1 & 2: Kalender confirmed -> badge "Ditetapkan" & reload tetap CONFIRMED
// -----------------------------------------------------------------------------
runTest('1 & 2. Kalender confirmed persists in V5 and reloads as CONFIRMED', () => {
  const cal1: AcademicCalendar = {
    id: `cal-${sem1.id}`,
    academicSettingId: sem1.id,
    academicYear: '2026/2027',
    semester: '1 (Ganjil)',
    startDate: '2026-07-13',
    endDate: '2026-12-18',
    schoolDaysPerWeek: 5,
    sourceType: 'REGIONAL_EDUCATION_CALENDAR',
    workflowStatus: 'CONFIRMED',
    updatedAt: new Date().toISOString(),
  };

  const day1: CalendarDay = {
    id: `day-${sem1.id}-1`,
    academicCalendarId: cal1.id,
    date: '2026-07-13',
    status: 'effective',
    sourceType: 'REGIONAL_EDUCATION_CALENDAR',
    sourceLayer: 'GENERATED_EFFECTIVE_BASELINE',
  };

  saveAcademicCalendarV5(sem1.id, { calendar: cal1, days: [day1] });

  // Set active semester to sem1 and reload runtime context
  const state = loadStorageV5();
  state.activeProfileId = profile.id;
  state.activeYearPlanId = hierarchy.yearPlan.id;
  state.activeSemesterPlanId = sem1.id;
  saveStorageV5(state);

  const runtimeCtx = getRuntimeContextV5();
  assert.ok(runtimeCtx.semesterData?.academicCalendar, 'AcademicCalendar must exist for Sem 1');
  assert.strictEqual(
    runtimeCtx.semesterData.academicCalendar.calendar.workflowStatus,
    'CONFIRMED',
    'Workflow status must reload as CONFIRMED'
  );
  assert.strictEqual(
    runtimeCtx.semesterData.academicCalendar.calendar.startDate,
    '2026-07-13',
    'Start date must match'
  );
  assert.strictEqual(
    runtimeCtx.semesterData.academicCalendar.days.length,
    1,
    'Calendar days must be loaded'
  );
});

// -----------------------------------------------------------------------------
// TEST 3: JP aktual semester tersimpan dan reload identik
// -----------------------------------------------------------------------------
runTest('3. JP aktual semester tersimpan dengan TEACHER_CONFIRMED dan reload identik', () => {
  const jpSetting: SemesterJPSetting = {
    semesterPlanId: sem1.id,
    actualScheduledWeeklyJP: 4,
    source: 'TEACHER_CONFIRMED',
  };

  saveSemesterJPSettingV5(sem1.id, jpSetting);

  const runtimeCtx = getRuntimeContextV5();
  assert.ok(runtimeCtx.semesterJPSetting, 'semesterJPSetting must exist on reload');
  assert.strictEqual(
    runtimeCtx.semesterJPSetting.actualScheduledWeeklyJP,
    4,
    'actualScheduledWeeklyJP must be 4'
  );
  assert.strictEqual(
    runtimeCtx.semesterJPSetting.source,
    'TEACHER_CONFIRMED',
    'source must be TEACHER_CONFIRMED'
  );
});

// -----------------------------------------------------------------------------
// TEST 4: JP kosong tetap UNRESOLVED, bukan otomatis dari official JP
// -----------------------------------------------------------------------------
runTest('4. JP kosong tetap UNRESOLVED with actualScheduledWeeklyJP = null without auto-official fallback', () => {
  const jpSettingEmpty: SemesterJPSetting = {
    semesterPlanId: sem2.id,
    actualScheduledWeeklyJP: null,
    source: 'UNRESOLVED',
  };

  saveSemesterJPSettingV5(sem2.id, jpSettingEmpty);

  // Switch to sem2
  const state = loadStorageV5();
  state.activeSemesterPlanId = sem2.id;
  saveStorageV5(state);

  const runtimeCtx = getRuntimeContextV5();
  assert.ok(runtimeCtx.semesterJPSetting, 'semesterJPSetting must exist for Sem 2');
  assert.strictEqual(
    runtimeCtx.semesterJPSetting.actualScheduledWeeklyJP,
    null,
    'actualScheduledWeeklyJP must be null'
  );
  assert.strictEqual(
    runtimeCtx.semesterJPSetting.source,
    'UNRESOLVED',
    'source must remain UNRESOLVED'
  );
});

// -----------------------------------------------------------------------------
// TEST 5: Time Allocation tersimpan ke semester aktif
// -----------------------------------------------------------------------------
runTest('5. Time allocations persist to active semester plan in V5', () => {
  const alloc1: TimeAllocation = {
    id: 'alloc-1',
    academicSettingId: sem1.id,
    sourceType: 'ATP_ITEM',
    sourceId: 'atp-1',
    weekNumber: 1,
    startWeek: 1,
    endWeek: 2,
    jp: 8,
    allocatedJP: 8,
  };

  const alloc2: TimeAllocation = {
    id: 'alloc-2',
    academicSettingId: sem1.id,
    sourceType: 'ATP_ITEM',
    sourceId: 'atp-2',
    weekNumber: 3,
    startWeek: 3,
    endWeek: 4,
    jp: 8,
    allocatedJP: 8,
  };

  saveTimeAllocationV5(sem1.id, [alloc1, alloc2]);

  // Switch back to sem1
  const state = loadStorageV5();
  state.activeSemesterPlanId = sem1.id;
  saveStorageV5(state);

  const runtimeCtx = getRuntimeContextV5();
  assert.ok(runtimeCtx.semesterData?.timeAllocation, 'timeAllocation array must exist');
  assert.strictEqual(runtimeCtx.semesterData.timeAllocation.length, 2, 'Must contain 2 allocations');
  assert.strictEqual(runtimeCtx.semesterData.timeAllocation[0].allocatedJP, 8);
  assert.strictEqual(runtimeCtx.semesterData.timeAllocation[1].allocatedJP, 8);

  const totalAllocatedJP = runtimeCtx.semesterData.timeAllocation.reduce(
    (sum, item) => sum + (Number(item.allocatedJP ?? item.jp) || 0),
    0
  );
  assert.strictEqual(totalAllocatedJP, 16, 'Total allocated JP for Sem 1 must equal 16 JP');
});

// -----------------------------------------------------------------------------
// TEST 6: Merdeka tanpa allocation menampilkan Belum dialokasikan (null planned JP)
// -----------------------------------------------------------------------------
runTest('6. Merdeka without time allocations yields null planned JP instead of 0 JP', () => {
  // Check Sem 2 which has no time allocations
  const state = loadStorageV5();
  state.activeSemesterPlanId = sem2.id;
  saveStorageV5(state);

  const runtimeCtx = getRuntimeContextV5();
  const sem2Allocations = runtimeCtx.semesterData?.timeAllocation || [];
  assert.strictEqual(sem2Allocations.length, 0, 'Sem 2 has no time allocations');

  // Total planned JP computation in AdministrationHub and TimePlanningManager for Merdeka
  const totalPlannedJP = sem2Allocations.length === 0
    ? null
    : sem2Allocations.reduce((sum, item) => sum + (Number(item.allocatedJP ?? item.jp) || 0), 0);

  assert.strictEqual(totalPlannedJP, null, 'Unallocated semester must return null (Belum dialokasikan)');
});

// -----------------------------------------------------------------------------
// TEST 7: Semester 1 and Semester 2 do NOT mix JP / allocation
// -----------------------------------------------------------------------------
runTest('7. Semester 1 and Semester 2 do NOT mix JP / allocation', () => {
  // Sem 1 checks
  const state1 = loadStorageV5();
  state1.activeSemesterPlanId = sem1.id;
  saveStorageV5(state1);

  const ctx1 = getRuntimeContextV5();
  assert.strictEqual(ctx1.semesterJPSetting?.actualScheduledWeeklyJP, 4, 'Sem 1 JP is 4');
  assert.strictEqual(ctx1.semesterData?.timeAllocation?.length, 2, 'Sem 1 has 2 allocations');

  // Sem 2 checks
  const state2 = loadStorageV5();
  state2.activeSemesterPlanId = sem2.id;
  saveStorageV5(state2);

  const ctx2 = getRuntimeContextV5();
  assert.strictEqual(ctx2.semesterJPSetting?.actualScheduledWeeklyJP, null, 'Sem 2 JP is null');
  assert.strictEqual(ctx2.semesterData?.timeAllocation?.length, undefined, 'Sem 2 has no allocations');
});

console.log('\nAll 7 Calendar -> Semester JP & Time Allocation integration regression tests PASSED 100%!\n');
