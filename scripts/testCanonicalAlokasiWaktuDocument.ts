import assert from 'assert';
import {
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
  buildPromesProjection,
  buildAlokasiWaktuProjection,
  generateAlokasiWaktu,
  generatePdfDocument,
  validateDocumentRequirements,
  DocumentGenerationContext,
} from '../src/services/documentEngine';
import {
  AcademicCalendar,
  CalendarDay,
  TimeAllocation,
  AcademicSetting,
  ATPData,
} from '../src/types';

function runTest(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    try {
      await fn();
      console.log(`[PASS] ${name}`);
    } catch (err) {
      console.error(`[FAIL] ${name}`);
      console.error(err);
      process.exit(1);
    }
  })();
}

class MockLocalStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) || null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

const mockStorage = new MockLocalStorage();
(globalThis as any).localStorage = mockStorage;

async function main() {
  console.log('=== RUNNING CANONICAL ALOKASI WAKTU DOCUMENT REGRESSION ===\n');

  const school = createSchoolV5({
    name: 'SD Merdeka B.4.3B',
    npsn: '20230099',
    address: 'Jl. Merdeka No. 1',
    village: 'Maju',
    district: 'Jaya',
    regency: 'Bandung',
    province: 'Jawa Barat',
    principalName: 'Kepala Sekolah',
    principalNip: '197001011990011001',
  });

  const profile = createProfileV5({
    name: 'Guru Alokasi Waktu',
    nip: '198501012010011001',
    status: 'PNS',
    defaultSubject: 'Matematika',
    defaultLevel: 'SD',
    schoolId: school.id,
  });

  const hierarchy = createYearHierarchyV5({
    schoolId: school.id,
    profileId: profile.id,
    academicYear: '2026/2027',
    grade: '4',
    level: 'SD',
    subject: 'Matematika',
    curriculumType: 'KURIKULUM_MERDEKA',
  });

  const sem1 = hierarchy.semesterPlans[0];
  const sem2 = hierarchy.semesterPlans[1];

  const sampleAnnualATP: ATPData = {
    id: `atp-annual-${hierarchy.yearPlan.id}`,
    academicSettingId: hierarchy.yearPlan.id,
    rationale: 'Rasional ATP Tahunan',
    totalJP: 144,
    updatedAt: new Date().toISOString(),
    items: [
      { id: 'atp-1', stepNumber: 1, tpCode: 'TP.1', tpStatement: 'Bilangan Cacah', materialScope: 'Bilangan', jp: 99 },
      { id: 'atp-2', stepNumber: 2, tpCode: 'TP.2', tpStatement: 'Penjumlahan', materialScope: 'Operasi Hitung', jp: 99 },
      { id: 'atp-3', stepNumber: 3, tpCode: 'TP.3', tpStatement: 'Pengurangan', materialScope: 'Operasi Hitung', jp: 99 },
      { id: 'atp-4', stepNumber: 4, tpCode: 'TP.4', tpStatement: 'Perkalian', materialScope: 'Operasi Hitung', jp: 99 },
      { id: 'atp-5', stepNumber: 5, tpCode: 'TP.5', tpStatement: 'Pembagian', materialScope: 'Operasi Hitung', jp: 99 },
    ],
  };

  saveATPV5(hierarchy.yearPlan.id, sampleAnnualATP);
  const annualAtpBackup = JSON.stringify(sampleAnnualATP);

  function makeConfirmedCalendarDays(calId: string, startDateStr: string, weeks: number): CalendarDay[] {
    const days: CalendarDay[] = [];
    const start = new Date(startDateStr);
    let dayCounter = 1;

    for (let w = 0; w < weeks; w++) {
      for (let d = 0; d < 7; d++) {
        const isWeekday = d >= 0 && d <= 4;
        days.push({
          id: `day-${calId}-${dayCounter++}`,
          academicCalendarId: calId,
          date: start.toISOString().slice(0, 10),
          status: isWeekday ? 'EFFECTIVE_LEARNING' : 'NON_LEARNING',
        });
        start.setDate(start.getDate() + 1);
      }
    }
    return days;
  }

  const s1CalId = `cal-${sem1.id}`;
  const s1Days = makeConfirmedCalendarDays(s1CalId, '2026-07-13', 18); // 18 weeks -> 90 Available JP @ 5 JP/wk
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
    actualScheduledWeeklyJP: 5,
    source: 'TEACHER_CONFIRMED',
  });

  const activeSetting: AcademicSetting = {
    id: sem1.id,
    profileId: profile.id,
    academicYear: '2026/2027',
    grade: '4',
    level: 'SD',
    phase: 'B',
    subject: 'Matematika',
    semester: '1 (Ganjil)',
    curriculum: 'Kurikulum Merdeka',
    curriculumType: 'KURIKULUM_MERDEKA',
    subjectWeeklyJP: 3,
    totalHoursPerWeek: 3,
    updatedAt: new Date().toISOString(),
  };

  const s1Allocations: TimeAllocation[] = [
    { id: 'alloc-1', academicSettingId: sem1.id, sourceType: 'ATP_ITEM', sourceId: 'atp-1', atpItemId: 'atp-1', allocatedJP: 12, jp: 12, startWeek: 1, endWeek: 3 },
    { id: 'alloc-2', academicSettingId: sem1.id, sourceType: 'ATP_ITEM', sourceId: 'atp-2', atpItemId: 'atp-2', allocatedJP: 16, jp: 16, startWeek: 4, endWeek: 7 },
    { id: 'alloc-3', academicSettingId: sem1.id, sourceType: 'ATP_ITEM', sourceId: 'atp-3', atpItemId: 'atp-3', allocatedJP: 20, jp: 20, startWeek: 8, endWeek: 12 },
  ];

  saveTimeAllocationV5(sem1.id, s1Allocations);

  const baseContext: DocumentGenerationContext = {
    school,
    profile,
    academicSetting: activeSetting,
    atp: sampleAnnualATP,
    calendar: s1Cal,
    calendarDays: s1Days,
    timeAllocations: s1Allocations,
    semesterJPSetting: { semesterPlanId: sem1.id, actualScheduledWeeklyJP: 5, source: 'TEACHER_CONFIRMED' },
    documentMode: 'data',
  };

  // Case 1: ATPItem.jp ignored
  await runTest('Case 1. ATPItem.jp is ignored; TimeAllocation.allocatedJP (12) is SSOT', () => {
    const proj = buildAlokasiWaktuProjection(baseContext);
    assert.strictEqual(proj.rows[0].allocatedJP, 12, 'Must be 12 JP from TimeAllocation, not 99 JP from ATPItem');
  });

  // Case 2: Unallocated ATP excluded
  await runTest('Case 2. Unallocated ATP items are excluded; only allocated semester rows appear', () => {
    const proj = buildAlokasiWaktuProjection(baseContext);
    assert.strictEqual(proj.rows.length, 3, 'Must include exactly 3 allocated rows (not 5 from annual ATP)');
  });

  // Case 3: Week range canonical
  await runTest('Case 3. Week range is startWeek to endWeek (e.g. 4 to 7)', () => {
    const proj = buildAlokasiWaktuProjection(baseContext);
    assert.strictEqual(proj.rows[1].startWeek, 4);
    assert.strictEqual(proj.rows[1].endWeek, 7);
  });

  // Case 4: Weekly JP canonical
  await runTest('Case 4. Beban JP Intrakurikuler per Minggu comes strictly from SemesterJPSetting (5 JP)', () => {
    const proj = buildAlokasiWaktuProjection(baseContext);
    assert.strictEqual(proj.actualScheduledWeeklyJP, 5, 'Must strictly be 5 from SemesterJPSetting');
  });

  // Case 5: Assessment + Reserve preserved
  await runTest('Case 5. Non-ATP Assessment and Reserve allocations appear as rows and enter total allocated JP', () => {
    const allocsWithAsmAndRes: TimeAllocation[] = [
      ...s1Allocations,
      { id: 'alloc-asm', academicSettingId: sem1.id, sourceType: 'ASSESSMENT', sourceId: 'pts', allocatedJP: 4, jp: 4, startWeek: 13, endWeek: 13, notes: 'PTS' },
      { id: 'alloc-res', academicSettingId: sem1.id, sourceType: 'RESERVE', sourceId: 'cad', allocatedJP: 8, jp: 8, startWeek: 18, endWeek: 18, notes: 'Cadangan' },
    ];

    const ctx: DocumentGenerationContext = { ...baseContext, timeAllocations: allocsWithAsmAndRes };
    const proj = buildAlokasiWaktuProjection(ctx);

    assert.strictEqual(proj.rows.length, 3);
    assert.strictEqual(proj.assessmentRows.length, 1);
    assert.strictEqual(proj.reserveRows.length, 1);
    assert.strictEqual(proj.totalAllocatedJP, 60, '12 + 16 + 20 + 4 + 8 = 60 JP');
  });

  // Case 6: Validation summary
  await runTest('Case 6. Summary metrics (totalAllocatedJP, remainingJP, validationStatus) match canonical projection', () => {
    const proj = buildAlokasiWaktuProjection(baseContext);
    assert.strictEqual(proj.totalAllocatedJP, 48); // 12 + 16 + 20
    assert.strictEqual(proj.availableJP, 90); // 18 wks * 5 JP
    assert.strictEqual(proj.remainingJP, 42); // 90 - 48
    assert.strictEqual(proj.validationStatus, 'UNDER_ALLOCATED');
  });

  // Case 7: Semester isolation
  await runTest('Case 7. Input mixed S1 + S2 allocations filtered to active S1 semester only', () => {
    const mixedAllocations: TimeAllocation[] = [
      { id: 'alloc-s1', academicSettingId: sem1.id, sourceType: 'ATP_ITEM', sourceId: 'atp-1', atpItemId: 'atp-1', allocatedJP: 12, jp: 12, startWeek: 1, endWeek: 3 },
      { id: 'alloc-s2', academicSettingId: sem2.id, sourceType: 'ATP_ITEM', sourceId: 'atp-4', atpItemId: 'atp-4', allocatedJP: 20, jp: 20, startWeek: 1, endWeek: 4 },
    ];

    const ctx: DocumentGenerationContext = { ...baseContext, timeAllocations: mixedAllocations };
    const proj = buildAlokasiWaktuProjection(ctx);

    assert.strictEqual(proj.rows.length, 1);
    assert.strictEqual(proj.rows[0].atpItemId, 'atp-1');
  });

  // Case 8: Missing readiness (calendar unconfirmed)
  await runTest('Case 8. Unconfirmed calendar causes projection.isReady = false, validateDocumentRequirements false, DOCX & PDF reject', async () => {
    const unconfirmedCal: AcademicCalendar = { ...s1Cal, workflowStatus: 'UNRESOLVED' };
    const ctx: DocumentGenerationContext = { ...baseContext, calendar: unconfirmedCal };

    const proj = buildAlokasiWaktuProjection(ctx);
    assert.strictEqual(proj.isReady, false);

    const valRes = validateDocumentRequirements('ALOKASI_WAKTU', ctx);
    assert.strictEqual(valRes.isValid, false);

    await assert.rejects(async () => {
      await generateAlokasiWaktu(ctx);
    }, /kalender pendidikan/);

    await assert.rejects(async () => {
      await generatePdfDocument('ALOKASI_WAKTU', ctx);
    }, /kalender pendidikan/);
  });

  // Case 9: Missing SemesterJPSetting
  await runTest('Case 9. Missing SemesterJPSetting causes DOCX and PDF export to fail closed', async () => {
    const ctx: DocumentGenerationContext = { ...baseContext, semesterJPSetting: undefined };

    const proj = buildAlokasiWaktuProjection(ctx);
    assert.strictEqual(proj.isReady, false);

    await assert.rejects(async () => {
      await generateAlokasiWaktu(ctx);
    }, /Jam Pelajaran/);

    await assert.rejects(async () => {
      await generatePdfDocument('ALOKASI_WAKTU', ctx);
    }, /Jam Pelajaran/);
  });

  // Case 10: Blank mode
  await runTest('Case 10. Blank mode produces DOCX and PDF without requiring confirmed semester data', async () => {
    const blankCtx: DocumentGenerationContext = {
      school,
      profile,
      academicSetting: activeSetting,
      calendar: undefined,
      calendarDays: [],
      timeAllocations: [],
      semesterJPSetting: undefined,
      documentMode: 'blank',
      skipDownload: true,
    };

    const docxRes = await generateAlokasiWaktu(blankCtx);
    assert.strictEqual(docxRes.success, true);

    const pdfRes = await generatePdfDocument('ALOKASI_WAKTU', blankCtx);
    assert.ok(pdfRes.blob);
  });

  // Case 11: Preview / DOCX / PDF contract
  await runTest('Case 11. DOCX and PDF generators execute cleanly using canonical Alokasi Waktu projection', async () => {
    const ctx: DocumentGenerationContext = { ...baseContext, skipDownload: true };

    const docxRes = await generateAlokasiWaktu(ctx);
    assert.strictEqual(docxRes.success, true);
    assert.ok(docxRes.blob);

    const pdfRes = await generatePdfDocument('ALOKASI_WAKTU', ctx);
    assert.ok(pdfRes.blob);
    assert.strictEqual(pdfRes.fileName.includes('Alokasi_Waktu'), true);
  });

  // Case 12: Annual ATP immutable
  await runTest('Case 12. Annual ATP remains byte-for-byte unmodified after Alokasi Waktu workflows', () => {
    const runtime = getRuntimeContextV5();
    const currentAnnualAtp = runtime.annualData?.atp;
    assert.strictEqual(
      JSON.stringify(currentAnnualAtp),
      annualAtpBackup,
      'Annual ATP must remain byte-for-byte unmodified'
    );
  });

  console.log('\nAll Canonical Alokasi Waktu Document regression tests PASSED 100%!\n');
}

main();
