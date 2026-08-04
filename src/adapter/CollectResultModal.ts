import { App, Modal, Notice, Setting } from 'obsidian';
import { Paper } from '../collect/Paper';
import type { CollectionCoverage } from '../collect/API';

// 수집 테스트 결과 창. 원시 JSON을 그대로 뿌리는 대신, "이번 수집이 제대로 동작했는가"를
// 항목별로 판정해서 보여준다 — 편수만 봐서는 날짜 필터가 먹었는지, 페이지네이션이 실제로
// 돌았는지 알 수 없기 때문이다(둘 다 예전에 조용히 깨져 있던 부분이라 눈으로 확인할
// 수단이 필요하다). 전체 Paper[]는 클립보드 복사 버튼으로 가져간다.

export interface CollectTestContext {
	label: string;
	keyword: string;
	// 날짜 구간 수집이면 요청한 구간. SearchBase 같은 단발 조회면 undefined.
	window?: { from: number; to: number };
	usedS2Key: boolean;
}

// 판정 한 줄. ok가 undefined면 판정 없이 정보만 보여준다.
interface CheckLine {
	label: string;
	detail: string;
	ok?: boolean;
	note?: string;
}

function isoDate(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

// publicationDate("YYYY-MM-DD")를 epoch ms로. 형식이 아니면 undefined.
function publicationMs(paper: Paper): number | undefined {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(paper.publicationDate)) {
		return undefined;
	}
	const ms = Date.parse(`${paper.publicationDate}T00:00:00Z`);
	return Number.isFinite(ms) ? ms : undefined;
}

function buildChecks(
	papers: Paper[],
	coverage: CollectionCoverage | undefined,
	context: CollectTestContext,
): CheckLine[] {
	const checks: CheckLine[] = [];

	// ── 날짜 필터가 실제로 적용됐는가 ──────────────────────────────────
	// 예전에는 '+TO+'가 이중 인코딩돼 필터가 통째로 무시됐다. 그때는 구간과 무관한
	// 아무 연도 논문이 섞여 나왔으므로, 수신 논문의 날짜 분포가 곧 판정 근거가 된다.
	if (context.window) {
		const dated = papers.map(publicationMs).filter((ms): ms is number => ms !== undefined);
		if (dated.length === 0) {
			checks.push({
				label: '날짜 필터',
				detail: '읽을 수 있는 publicationDate가 없어 판정 불가',
			});
		} else {
			const min = Math.min(...dated);
			const max = Math.max(...dated);
			// 하루 여유를 둔다 — publicationDate는 날짜 단위인데 구간은 분 단위라
			// 경계에서 하루 차이가 정상적으로 발생한다.
			const dayMs = 24 * 60 * 60 * 1000;
			const outside = dated.filter(
				(ms) => ms < context.window!.from - dayMs || ms > context.window!.to + dayMs,
			).length;
			checks.push({
				label: '날짜 필터',
				detail:
					`요청 ${isoDate(context.window.from)} ~ ${isoDate(context.window.to)} / ` +
					`수신 ${isoDate(min)} ~ ${isoDate(max)}` +
					(outside > 0 ? ` (구간 밖 ${outside}편)` : ''),
				ok: outside === 0,
				note:
					outside > 0
						? 'arXiv의 submittedDate는 최신 버전 제출일 기준이라 v1 발행일이 구간보다 이를 수 있다. ' +
							'구간과 전혀 무관한 연도가 섞여 있다면 필터가 안 먹은 것이다.'
						: undefined,
			});
		}
	}

	// ── 페이지네이션이 실제로 돌았는가 ────────────────────────────────
	// 예전에는 1회 요청 50건 고정이라 그 이상은 조용히 사라졌다.
	if (coverage) {
		const total = coverage.totalResults;
		const totalText = total >= 0 ? `${total}건` : '(arXiv가 미보고)';
		checks.push({
			label: '페이지네이션',
			detail: `${coverage.pages}페이지 요청 → ${papers.length}편 수신 / arXiv 보고 전체 ${totalText}`,
			ok: total < 0 ? undefined : coverage.truncated || papers.length >= Math.min(total, 1),
			note:
				coverage.pages <= 1
					? '1페이지에서 끝났다 — 이 구간엔 100건 미만이라 페이지네이션 자체는 검증되지 않았다. ' +
						'구간을 넓히면 여러 페이지를 도는 걸 확인할 수 있다.'
					: undefined,
		});

		// ── 커버리지 커서 ─────────────────────────────────────────────
		checks.push({
			label: '커버리지 커서',
			detail: coverage.truncated
				? `상한에 걸려 잘림 — ${isoDate(coverage.coveredThrough)}까지 확인됨`
				: `구간 전체 확인 완료 (${isoDate(coverage.coveredThrough)})`,
			ok: !coverage.truncated,
			note: coverage.truncated
				? 'run()이 구현되면 이 값을 커서로 저장해 다음 패스가 이어받아야 한다.'
				: undefined,
		});
	}

	// ── 인용수 보강(S2) ───────────────────────────────────────────────
	const citationsKnown = papers.filter((p) => p.citationsKnown).length;
	checks.push({
		label: '인용수 보강',
		detail:
			`${citationsKnown}/${papers.length}편 확인 / ` +
			`S2 키 ${context.usedS2Key ? '사용함' : '없음(익명 호출)'}`,
		ok: papers.length === 0 ? undefined : citationsKnown > 0,
		note:
			citationsKnown === 0 && papers.length > 0
				? '전부 실패했다. 익명 호출은 S2 rate limit(429)에 자주 걸린다 — ' +
					'설정 탭의 File 테스트에서 provider "semanticScholar"로 키를 등록하면 완화된다.'
				: undefined,
	});

	// ── 필드 매핑 ─────────────────────────────────────────────────────
	// 에러 응답이 가짜 Paper로 둔갑하던 버그가 있었으므로 sourceId 형식을 확인한다.
	const badSourceId = papers.filter((p) => !/^arxiv:[^:/]+$/.test(p.sourceId)).length;
	checks.push({
		label: '필드 매핑',
		detail:
			badSourceId === 0
				? `sourceId ${papers.length}편 모두 정상 형식(arxiv:xxxx)`
				: `sourceId 형식이 이상한 논문 ${badSourceId}편`,
		ok: badSourceId === 0,
		note: badSourceId > 0 ? 'arXiv 에러 응답이 Paper로 섞여 들어왔을 수 있다.' : undefined,
	});

	return checks;
}

export class CollectResultModal extends Modal {
	constructor(
		app: App,
		private readonly papers: Paper[],
		private readonly coverage: CollectionCoverage | undefined,
		private readonly context: CollectTestContext,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h3', { text: `${this.context.label} 수집 결과` });
		contentEl.createEl('p', {
			text: `키워드 "${this.context.keyword}" — ${this.papers.length}편 수집됨`,
		});

		contentEl.createEl('h4', { text: '검증' });
		for (const check of buildChecks(this.papers, this.coverage, this.context)) {
			const mark = check.ok === undefined ? '•' : check.ok ? '✅' : '⚠️';
			const setting = new Setting(contentEl)
				.setName(`${mark} ${check.label}`)
				.setDesc(check.note ? `${check.detail}\n${check.note}` : check.detail);
			setting.settingEl.addClass('papergraph3d-check-row');
		}

		// 샘플 — 필드가 실제로 어떻게 채워졌는지 눈으로 확인하는 용도.
		if (this.papers.length > 0) {
			contentEl.createEl('h4', { text: '샘플 (최대 5편)' });
			const list = contentEl.createEl('ul');
			for (const paper of this.papers.slice(0, 5)) {
				list.createEl('li', {
					text:
						`[${paper.publicationDate || '날짜 없음'}] ${paper.title} ` +
						`(${paper.sourceId}, 인용 ${paper.citationsKnown ? paper.citationCount : '미확인'})`,
				});
			}
		}

		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText('전체 JSON 클립보드 복사')
				.setCta()
				.onClick(() => {
					void navigator.clipboard
						.writeText(JSON.stringify({ papers: this.papers, coverage: this.coverage }, null, 2))
						.then(() => new Notice(`${this.papers.length}편 JSON 복사됨`));
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
