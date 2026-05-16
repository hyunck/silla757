/* =========================================================
   757년 신라 지도 뷰어 — 메인 로직
   ========================================================= */

(function () {
  'use strict';

  /* =========================================================
     설정값
     ========================================================= */
  const SVG_FILE = 'map_processed.svg';
  const PLACES_FILE = 'places.json';

  // 줌 레벨 임계값 (배율 기준)
  const ZOOM_THRESHOLDS = {
    L1: 1.0,   // 1.0 ~ 1.8
    L2: 1.8,   // 1.8 ~ 3.0
    L3: 3.0    // 3.0 ~ MAX
  };
  const ZOOM_MIN = 1.0;
  const ZOOM_MAX = 8.0;
  const ZOOM_STEP = 1.5;  // 버튼 한 번 누를 때 배율
  const ZOOM_WHEEL_FACTOR = 1.12;

  // 검색 시 자동 줌인 목표 배율
  const SEARCH_TARGET_ZOOM = {
    ju: 1.3,
    sogyeong: 1.4,
    geumseong: 1.4,
    neighbor: 1.0,
    vassal: 2.2,
    gun: 2.3,
    hyeon: 3.8,
    jeong10: 3.5,
    gijeong6: 4.5
  };

  // 카테고리 한글 라벨
  const CATEGORY_LABEL = {
    ju: '9주',
    sogyeong: '5소경',
    geumseong: '왕경',
    gun: '군',
    hyeon: '현',
    jeong10: '10정',
    gijeong6: '6기정',
    vassal: '속국',
    neighbor: '주변국'
  };

  /* =========================================================
     상태
     ========================================================= */
  const state = {
    svgEl: null,
    svgOriginalViewBox: null,   // {x, y, w, h}
    currentViewBox: null,
    zoom: 1.0,                   // 현재 줌 배율 (= origW / curW)
    zoomLevel: 'L1',
    isPanning: false,
    panStart: null,
    places: [],
    panelMode: 'search',         // 'search' | 'detail'
    panelOpen: false,
    selectedTextEl: null,
    // 렌더링 최적화
    rafPending: false,           // rAF throttle 플래그 (wheel 이벤트용)
    wheelTimer: null,            // 휠 정지 감지 타이머
    committedViewBox: null,      // CSS transform 기준이 되는 확정된 viewBox
    layers: {
      'ju-boundary': true,        // 9주 경계 (기본 ON)
      'balhae-border': true,      // 발해 국경 (기본 ON)
      'modern-region': false,     // 광역시·도 (기본 OFF)
      'modern-admin': false,      // 시·군·구 (기본 OFF)
      'gun-hyeon': true,          // 군·현 (기본 ON)
      'jeong': false,             // 6기정·10정 (기본 OFF) - 군현과 충돌하므로
      'neighbors': true,          // 주변국 (기본 ON)
      'vassals': true             // 속국 (기본 ON)
    }
  };

  /* =========================================================
     DOM 참조
     ========================================================= */
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const els = {
    map: $('#mapContainer'),
    loading: $('#mapLoading'),
    panel: $('#sidePanel'),
    panelToggleBtn: $('#panelToggleBtn'),
    backBtn: $('#backBtn'),
    searchInput: $('#searchInput'),
    clearBtn: $('#clearBtn'),
    searchMode: $('#searchMode'),
    detailMode: $('#detailMode'),
    searchResults: $('#searchResults'),
    searchEmpty: $('#searchEmpty'),
    detailTitle: $('#detailTitle'),
    detailHanja: $('#detailHanja'),
    detailCategoryTag: $('#detailCategoryTag'),
    zoomIn: $('#zoomInBtn'),
    zoomOut: $('#zoomOutBtn'),
    zoomReset: $('#resetBtn'),
    zoomLevelValue: $('#zoomLevelValue'),
    layerBtns: $$('.layer-btn')
  };

  /* =========================================================
     초기화
     ========================================================= */
  async function init() {
    try {
      const [svgText, placesData] = await Promise.all([
        fetch(SVG_FILE).then(r => r.text()),
        fetch(PLACES_FILE).then(r => r.json())
      ]);

      state.places = placesData;
      injectSvg(svgText);
      setupSvgInteractions();
      setupUI();
      hideLoading();
    } catch (err) {
      console.error('초기화 실패:', err);
      const loadingEl = els.loading;
      if (loadingEl) {
        loadingEl.innerHTML = `
          <p style="color:#b54b3a;font-weight:600;">지도를 불러올 수 없습니다.</p>
          <p style="color:#999;font-size:12px;margin-top:8px;">파일 경로를 확인해주세요.</p>
        `;
      }
    }
  }

  function injectSvg(svgText) {
    els.map.insertAdjacentHTML('afterbegin', svgText);
    const svg = els.map.querySelector('svg');
    state.svgEl = svg;

    // viewBox 파싱
    const vb = svg.getAttribute('viewBox').split(/\s+/).map(Number);
    state.svgOriginalViewBox = { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
    state.currentViewBox = { ...state.svgOriginalViewBox };
    state.committedViewBox = { ...state.svgOriginalViewBox };

    // preserveAspectRatio 설정 (지도가 화면에 비례 유지)
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    // 우산국 한자 보정 (SVG에 한자가 있으면 places.json에도 반영)
    const usan = state.places.find(p => p.name === '우산국');
    if (usan && !usan.hanja) usan.hanja = '于山國';
    const tamna = state.places.find(p => p.name === '탐라국');
    if (tamna && !tamna.hanja) tamna.hanja = '耽羅國';

    // 바다 효과 추가 (해안선 외측 글로우)
    addSeaEffect(svg);

    // 초기 줌 레벨 표시 설정
    applyZoomLevel();
    applyLayerVisibility();
  }

  /**
   * 한반도 해안선 바깥쪽(바다)에만 푸른 글로우를 추가하고,
   * 해안선과 영토 사이의 이격을 제거.
   *
   * 이전 접근법의 문제 (글로우만 추가, fill 없음):
   *   - 해안선 path는 stroke만 있고 fill:none이라, 영토 "흰색"은 실은 .map-container 배경
   *   - 마스크의 land path가 해안선 stroke의 *중심선*을 따라가서, stroke 두께의 절반만큼
   *     안쪽으로 잘림 → 해안선 바깥쪽 절반에는 글로우가 새어 보임 → 띠 모양 이격
   *   - 또한 해안선 path들엔 transform="translate(2.61 0.98)"이 적용되어 있는데,
   *     mask path는 transform을 받지 않아 추가로 어긋남
   *
   * 새 접근법: 영토 fill 레이어 + 정렬된 mask
   *   1. 해안선 path들을 복제해 fill 전용 레이어를 만들고 영토 색(--land)으로 채움
   *      → 해안선과 fill의 외곽이 정확히 일치 (같은 path, 같은 transform)
   *   2. 같은 fill path들을 mask 안에도 검정으로 그려서 정확한 육지 영역 정의
   *      → mask 경계가 fill 경계와 1:1 매칭 → 글로우가 영토 위로 새어들지 않음
   *   3. 본체 한반도 path는 open path라 그대로 fill하면 viewBox 바깥까지 칠해지므로,
   *      viewBox 위쪽 바깥으로 연장 후 닫는 closed 버전을 만들어 사용
   *   4. 렌더 순서(아래→위): 글로우(mask 적용) → 영토 fill → 원본 해안선 stroke
   *      → 영토가 글로우를 가리고, stroke가 영토 가장자리에 올라감 → 이격 없음
   *
   * fill 색은 CSS 변수 --land 로 제어 가능.
   */
  function addSeaEffect(svg) {
    const SVG_NS = 'http://www.w3.org/2000/svg';

    const haeanGroup = svg.querySelector('#해안선');
    if (!haeanGroup) return;
    if (svg.querySelector('#바다_효과')) return;

    const targetGroups = ['#한반도', '#국외'];
    const allCoastPaths = [];
    targetGroups.forEach(sel => {
      const g = haeanGroup.querySelector(sel);
      if (g) g.querySelectorAll('path').forEach(p => allCoastPaths.push(p));
    });
    if (allCoastPaths.length === 0) return;

    // 본체 path 식별 (가장 긴 path = 한반도 본토 해안선)
    let mainPath = allCoastPaths[0];
    allCoastPaths.forEach(p => {
      if ((p.getAttribute('d') || '').length > (mainPath.getAttribute('d') || '').length) {
        mainPath = p;
      }
    });

    /**
     * 본체 path의 d를 closed shape으로 만들기.
     * 원본은 'V0'로 viewBox 바깥(8383, 0)으로 점프하며 끝나는 open path.
     * → 끝의 V/H/L 잘라낸 뒤 viewBox 위쪽 바깥에서 닫음.
     */
    function makeClosedLandPath(originalD) {
      let d = originalD.replace(/[VHL][\s,]*-?\d+\.?\d*$/i, '');
      // 끝점 부근에서 → 우측 위 바깥 → 좌측 위 바깥 → 시작점 부근으로 닫음
      d += ' L 8500 -1000 L -1000 -1000 Z';
      return d;
    }

    /** path d 끝의 불필요한 V/H/L 직선 명령 제거 (글로우 stroke용 — open shape 그대로) */
    function cleanPathD(d) {
      return d.replace(/[VHL][\s,]*-?\d+\.?\d*$/i, '');
    }

    /**
     * 원본 path의 d를 받아 "fill 가능한" d를 반환.
     *   - 본체(open path): closed 버전으로 변환
     *   - 작은 섬들(이미 Z로 닫힘): 그대로 사용
     * mask path와 영토 fill path 모두 이 함수를 거치므로 두 영역이 완벽히 일치.
     */
    function makeFillableD(originalPath) {
      const d = originalPath.getAttribute('d');
      if (!d) return null;
      if (originalPath === mainPath) return makeClosedLandPath(d);
      // 닫힌 path만 (Z로 끝남)
      if (!/[Zz]\s*$/.test(d)) return null;
      return d;
    }

    /** 원본 path의 transform 속성을 복제해 새 path에 그대로 부여 */
    function copyTransform(srcPath, dstPath) {
      const t = srcPath.getAttribute('transform');
      if (t) dstPath.setAttribute('transform', t);
    }

    // === defs에 mask와 filter 추가 ===
    let defs = svg.querySelector('defs');
    if (!defs) {
      defs = document.createElementNS(SVG_NS, 'defs');
      svg.insertBefore(defs, svg.firstChild);
    }

    // Blur 필터 (SVG 좌표계 기반 — CSS blur는 줌 시 비율 깨짐)
    if (!defs.querySelector('#sea-blur-near')) {
      defs.insertAdjacentHTML('beforeend',
        '<filter id="sea-blur-near" x="-50%" y="-50%" width="200%" height="200%">' +
        '<feGaussianBlur stdDeviation="7"/></filter>' +
        '<filter id="sea-blur-far" x="-50%" y="-50%" width="200%" height="200%">' +
        '<feGaussianBlur stdDeviation="14"/></filter>'
      );
    }

    // === 육지 마스크 생성: 바다(=육지 외부)만 흰색으로 보이도록 ===
    // <mask>의 흰색=보임, 검정=가림
    // 전체를 흰색으로 덮고, 한반도 본체 + 섬들을 검정으로 그려 글로우를 차단
    if (!defs.querySelector('#sea-mask')) {
      const mask = document.createElementNS(SVG_NS, 'mask');
      mask.setAttribute('id', 'sea-mask');
      mask.setAttribute('maskUnits', 'userSpaceOnUse');
      mask.setAttribute('x', '-2000');
      mask.setAttribute('y', '-2000');
      mask.setAttribute('width', '6000');
      mask.setAttribute('height', '8000');

      // 1) 흰색 배경 (모든 영역 = 보임)
      const bg = document.createElementNS(SVG_NS, 'rect');
      bg.setAttribute('x', '-2000');
      bg.setAttribute('y', '-2000');
      bg.setAttribute('width', '6000');
      bg.setAttribute('height', '8000');
      bg.setAttribute('fill', '#fff');
      mask.appendChild(bg);

      // 2) 한반도 본체 + 섬들: 검정 fill (글로우 가림)
      //    원본 transform을 그대로 복제해 정렬을 1:1로 맞춤
      allCoastPaths.forEach(p => {
        const fillableD = makeFillableD(p);
        if (!fillableD) return;
        const maskPath = document.createElementNS(SVG_NS, 'path');
        maskPath.setAttribute('d', fillableD);
        maskPath.setAttribute('fill', '#000');
        if (p === mainPath) maskPath.setAttribute('fill-rule', 'evenodd');
        copyTransform(p, maskPath);
        mask.appendChild(maskPath);
      });

      defs.appendChild(mask);
    }

    // === 글로우 레이어 (mask로 육지 영역 차단) ===
    function createGlowLayer(strokeColor, strokeWidth, filterId, opacity) {
      const layer = document.createElementNS(SVG_NS, 'g');
      layer.setAttribute('class', '바다_효과_레이어');
      layer.style.pointerEvents = 'none';
      layer.setAttribute('aria-hidden', 'true');
      layer.setAttribute('opacity', String(opacity));
      layer.setAttribute('filter', `url(#${filterId})`);
      layer.setAttribute('mask', 'url(#sea-mask)');

      allCoastPaths.forEach(originalPath => {
        const d = originalPath.getAttribute('d');
        if (!d) return;
        const cleanedD = cleanPathD(d);
        const cloned = document.createElementNS(SVG_NS, 'path');
        cloned.setAttribute('d', cleanedD);
        cloned.setAttribute('fill', 'none');
        cloned.setAttribute('stroke', strokeColor);
        cloned.setAttribute('stroke-width', String(strokeWidth));
        cloned.setAttribute('stroke-linejoin', 'round');
        cloned.setAttribute('stroke-linecap', 'round');
        copyTransform(originalPath, cloned);
        layer.appendChild(cloned);
      });
      return layer;
    }

    // === 영토 fill 레이어 (해안선 안쪽을 영토 색으로 채움) ===
    // mask에 사용한 것과 동일한 closed path들을 사용하므로 mask와 fill이 완벽히 일치.
    // 결과적으로 해안선 stroke가 fill의 외곽 위에 정확히 올라가 이격이 사라짐.
    function createLandFillLayer() {
      const layer = document.createElementNS(SVG_NS, 'g');
      layer.setAttribute('id', '영토_fill');
      layer.style.pointerEvents = 'none';
      layer.setAttribute('aria-hidden', 'true');

      allCoastPaths.forEach(originalPath => {
        const fillableD = makeFillableD(originalPath);
        if (!fillableD) return;
        const filled = document.createElementNS(SVG_NS, 'path');
        filled.setAttribute('d', fillableD);
        // CSS 변수로 색 제어 가능 (fallback: 한지 톤)
        // 배경 그라데이션이 그대로 비쳐 보이도록 투명하게
        // (글로우 차단은 #sea-mask가 담당)
        filled.setAttribute('fill', 'var(--land, transparent)');
        if (originalPath === mainPath) filled.setAttribute('fill-rule', 'evenodd');
        copyTransform(originalPath, filled);
        layer.appendChild(filled);
      });
      return layer;
    }

    const seaContainer = document.createElementNS(SVG_NS, 'g');
    seaContainer.setAttribute('id', '바다_효과');
    seaContainer.style.pointerEvents = 'none';
    seaContainer.setAttribute('aria-hidden', 'true');

    const farGlow = createGlowLayer('#9bbcd5', 28, 'sea-blur-far', 0.65);
    const nearGlow = createGlowLayer('#7ba6c4', 14, 'sea-blur-near', 0.85);
    const landFill = createLandFillLayer();

    // 렌더 순서(아래→위): 먼 글로우 → 가까운 글로우 → 영토 fill
    seaContainer.appendChild(farGlow);
    seaContainer.appendChild(nearGlow);
    seaContainer.appendChild(landFill);

    // 해안선 그룹 맨 앞(=가장 아래)에 삽입 → 원본 stroke들이 영토 fill 위에 그려짐
    haeanGroup.insertBefore(seaContainer, haeanGroup.firstChild);
  }

  function hideLoading() {
    if (els.loading) {
      els.loading.classList.add('hidden');
      setTimeout(() => { els.loading.remove(); }, 350);
    }
  }

  /* =========================================================
     SVG 인터랙션: 줌/팬 + 텍스트 클릭
     ========================================================= */
  function setupSvgInteractions() {
    const map = els.map;

    // 마우스 드래그 (팬)
    map.addEventListener('mousedown', onPanStart);
    window.addEventListener('mousemove', onPanMove);
    window.addEventListener('mouseup', onPanEnd);

    // 휠 줌
    map.addEventListener('wheel', onWheel, { passive: false });

    // 터치 (모바일 - 핀치 줌 + 팬)
    map.addEventListener('touchstart', onTouchStart, { passive: false });
    map.addEventListener('touchmove', onTouchMove, { passive: false });
    map.addEventListener('touchend', onTouchEnd);

    // 텍스트 클릭 이벤트 (위임)
    state.svgEl.addEventListener('click', onSvgClick);
  }

  function onPanStart(e) {
    // 텍스트 클릭은 팬으로 보지 않음
    if (e.target.classList && e.target.classList.contains('place-text')) return;
    if (e.target.tagName === 'tspan') return;

    state.isPanning = true;
    state.panStart = { x: e.clientX, y: e.clientY, vb: { ...state.currentViewBox } };
    state.panMoved = false;
    els.map.classList.add('dragging');
  }
  function onPanMove(e) {
    if (!state.isPanning) return;
    const dx = e.clientX - state.panStart.x;
    const dy = e.clientY - state.panStart.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) state.panMoved = true;

    const rect = els.map.getBoundingClientRect();
    const scaleX = state.panStart.vb.w / rect.width;
    const scaleY = state.panStart.vb.h / rect.height;
    state.currentViewBox.x = state.panStart.vb.x - dx * scaleX;
    state.currentViewBox.y = state.panStart.vb.y - dy * scaleY;

    // 팬 중: CSS transform으로 이동 (viewBox 변경 없음 → 레이아웃 재계산 없음)
    applySvgTransform();
  }
  function onPanEnd() {
    if (!state.isPanning) return;
    state.isPanning = false;
    els.map.classList.remove('dragging');
    // 팬 종료: viewBox 확정 후 transform 제거
    commitViewBox();
  }

  function onWheel(e) {
    e.preventDefault();

    // rAF throttle: 60fps 초과 이벤트 무시
    if (state.rafPending) return;
    state.rafPending = true;
    requestAnimationFrame(() => { state.rafPending = false; });

    const rect = els.map.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width;
    const my = (e.clientY - rect.top) / rect.height;
    const factor = e.deltaY < 0 ? ZOOM_WHEEL_FACTOR : 1 / ZOOM_WHEEL_FACTOR;
    zoomAt(mx, my, factor);

    // 휠 정지 150ms 후 viewBox 확정 (텍스트 선명도 복원)
    clearTimeout(state.wheelTimer);
    state.wheelTimer = setTimeout(commitViewBox, 150);
  }

  /* 두 손가락 핀치 줌 */
  let touchState = null;
  function onTouchStart(e) {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      // 텍스트 터치면 팬 시작 안 함
      if (t.target && t.target.classList && t.target.classList.contains('place-text')) return;
      state.isPanning = true;
      state.panStart = { x: t.clientX, y: t.clientY, vb: { ...state.currentViewBox } };
      state.panMoved = false;
    } else if (e.touches.length === 2) {
      state.isPanning = false;
      const [a, b] = e.touches;
      touchState = {
        dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
        midX: (a.clientX + b.clientX) / 2,
        midY: (a.clientY + b.clientY) / 2,
        vb: { ...state.currentViewBox }
      };
      e.preventDefault();
    }
  }
  function onTouchMove(e) {
    if (e.touches.length === 1 && state.isPanning) {
      const t = e.touches[0];
      const dx = t.clientX - state.panStart.x;
      const dy = t.clientY - state.panStart.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) state.panMoved = true;
      const rect = els.map.getBoundingClientRect();
      const scaleX = state.panStart.vb.w / rect.width;
      const scaleY = state.panStart.vb.h / rect.height;
      state.currentViewBox.x = state.panStart.vb.x - dx * scaleX;
      state.currentViewBox.y = state.panStart.vb.y - dy * scaleY;
      applySvgTransform();
      e.preventDefault();
    } else if (e.touches.length === 2 && touchState) {
      const [a, b] = e.touches;
      const newDist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
      const factor = newDist / touchState.dist;
      const rect = els.map.getBoundingClientRect();
      const mx = (touchState.midX - rect.left) / rect.width;
      const my = (touchState.midY - rect.top) / rect.height;
      state.currentViewBox = { ...touchState.vb };
      zoomAt(mx, my, factor);
      e.preventDefault();
    }
  }
  function onTouchEnd(e) {
    if (e.touches.length === 0) {
      state.isPanning = false;
      touchState = null;
      commitViewBox();  // 터치 종료 시 viewBox 확정
    } else if (e.touches.length === 1 && touchState) {
      // 핀치 → 1손가락 팬으로 전환
      commitViewBox();
      const t = e.touches[0];
      state.isPanning = true;
      state.panStart = { x: t.clientX, y: t.clientY, vb: { ...state.currentViewBox } };
      touchState = null;
    }
  }

  function zoomAt(normX, normY, factor) {
    const cvb = state.currentViewBox;
    const targetX = cvb.x + cvb.w * normX;
    const targetY = cvb.y + cvb.h * normY;

    let newW = cvb.w / factor;
    let newH = cvb.h / factor;

    const origW = state.svgOriginalViewBox.w;
    const minW = origW / ZOOM_MAX;
    const maxW = origW / ZOOM_MIN;
    if (newW < minW) {
      const adjustFactor = newW / minW;
      newW = minW;
      newH = cvb.h * adjustFactor;
    }
    if (newW > maxW) {
      const adjustFactor = newW / maxW;
      newW = maxW;
      newH = cvb.h * adjustFactor;
    }

    state.currentViewBox.x = targetX - newW * normX;
    state.currentViewBox.y = targetY - newH * normY;
    state.currentViewBox.w = newW;
    state.currentViewBox.h = newH;
    state.zoom = origW / newW;

    // 줌 중에도 CSS transform (viewBox 변경은 정지 후 commitViewBox에서)
    applySvgTransform();
    applyZoomLevel();
  }

  function applyViewBox(animate = false) {
    const vb = state.currentViewBox;
    if (animate) {
      animateViewBox(vb);
    } else {
      state.svgEl.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
      state.committedViewBox = { ...vb };
      state.svgEl.style.transform = '';
    }
  }

  /**
   * CSS transform으로 SVG를 이동/스케일 (GPU 가속, 레이아웃 재계산 없음).
   * committedViewBox 기준으로 currentViewBox까지의 차이를 transform으로 표현.
   *
   * 원리:
   *   - SVG는 viewBox=committed 상태로 고정 (픽셀 → SVG 좌표 매핑 불변)
   *   - currentViewBox와 committedViewBox의 차이를 CSS transform(scale + translate)로 표현
   *   - 팬 종료/휠 정지 시 commitViewBox()로 viewBox를 확정하고 transform을 제거
   */
  function applySvgTransform() {
    const svg = state.svgEl;
    if (!svg) return;
    const cvb = state.currentViewBox;
    const com = state.committedViewBox;
    if (!com) return;

    // 스케일 비율: committed 대비 current의 확대/축소
    const scaleX = com.w / cvb.w;
    const scaleY = com.h / cvb.h;

    // SVG 요소 좌상단(0,0) 기준 translate 계산
    // committed viewBox에서 current viewBox 좌상단이 어디 있는지 (SVG 좌표 → 픽셀 비율)
    const tx = -(cvb.x - com.x) / com.w;  // 정규화된 좌표 (0~1)
    const ty = -(cvb.y - com.y) / com.h;

    // CSS transform: origin을 (0,0)으로 두고 계산
    svg.style.transformOrigin = '0 0';
    svg.style.transform = `translate(${tx * 100}%, ${ty * 100}%) scale(${scaleX}, ${scaleY})`;
  }

  /**
   * viewBox를 currentViewBox로 확정하고 CSS transform 제거.
   * 팬 종료, 휠 정지(150ms), 터치 종료 시 호출.
   * 이 시점에서 브라우저가 실제 SVG를 재렌더링 — 텍스트 선명도 복원.
   */
  function commitViewBox() {
    const svg = state.svgEl;
    if (!svg) return;
    const vb = state.currentViewBox;
    svg.style.transform = '';
    svg.style.transformOrigin = '';
    svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    state.committedViewBox = { ...vb };
  }

  function animateViewBox(targetVb, duration = 600) {
    const startVb = { ...state.currentViewBox };
    const start = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3); // easeOutCubic

    function step(now) {
      const t = Math.min((now - start) / duration, 1);
      const k = ease(t);
      const cur = {
        x: startVb.x + (targetVb.x - startVb.x) * k,
        y: startVb.y + (targetVb.y - startVb.y) * k,
        w: startVb.w + (targetVb.w - startVb.w) * k,
        h: startVb.h + (targetVb.h - startVb.h) * k
      };
      state.svgEl.setAttribute('viewBox', `${cur.x} ${cur.y} ${cur.w} ${cur.h}`);
      state.currentViewBox = cur;
      state.zoom = state.svgOriginalViewBox.w / cur.w;
      applyZoomLevel();
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function applyZoomLevel() {
    let level = 'L1';
    if (state.zoom >= ZOOM_THRESHOLDS.L3) level = 'L3';
    else if (state.zoom >= ZOOM_THRESHOLDS.L2) level = 'L2';

    // 초기 호출에서도 반드시 속성이 설정되도록 (초기 state는 L1, 계산값도 L1이라
    // 비교에서 통과되지 않아 속성이 누락되는 버그 방지)
    if (level !== state.zoomLevel || !els.map.hasAttribute('data-zoom-level')) {
      state.zoomLevel = level;
      els.map.setAttribute('data-zoom-level', level);
      updateZoomLevelLabel();
      // 9주/5소경 한자 tspan의 y 위치를 폰트 크기에 맞춰 조정
      adjustHanjaSpacing(level);
    }
  }

  /**
   * 9주/5소경/10정 한자 tspan의 y 좌표를 줌 레벨/폰트 변화에 맞춰 조정.
   * SVG의 y 속성은 절대 좌표라 CSS로 못 바꿈 — JS로 직접 조정.
   *
   * 한글 폰트 대비 한자 y 비율:
   *   9주 원본 30px → y=24 (비율 0.80)
   *   5소경 원본 24px → y=21.6 (비율 0.90)
   *   10정 원본 15px → y=14.4 (비율 0.96), 12px로 줄였으므로 y=11.5
   *
   * 줌 레벨별 한글 폰트(CSS에서 설정한 값):
   *   L1: 9주 30, 5소경 24
   *   L2: 9주 18, 5소경 16
   *   L3: 9주 13, 5소경 12
   *   10정은 12px 고정 → y=11.5 고정
   */
  function adjustHanjaSpacing(level) {
    if (!state.svgEl) return;
    const config = {
      L1: { ju: 24,   sogyeong: 21.6 },
      L2: { ju: 14.4, sogyeong: 14.4 },
      L3: { ju: 10.4, sogyeong: 10.8 }
    };
    const target = config[level];
    if (!target) return;

    // 9주: <text>명주<tspan class="cls-496"><tspan x="8.8" y="24">溟州</tspan></tspan></text>
    // 가장 안쪽 tspan의 y 속성을 변경
    state.svgEl.querySelectorAll('#_9주 text tspan tspan').forEach(sp => {
      sp.setAttribute('y', String(target.ju));
    });
    state.svgEl.querySelectorAll('#_5소경 text tspan tspan').forEach(sp => {
      sp.setAttribute('y', String(target.sogyeong));
    });
    // 10정은 폰트가 고정 12px이므로 y도 고정(한 번만 처리하면 충분하지만 안전하게 매번)
    state.svgEl.querySelectorAll('#_10정 text tspan tspan').forEach(sp => {
      sp.setAttribute('y', '11.5');
    });
  }

  function updateZoomLevelLabel() {
    const labels = {
      L1: '9주·5소경·금성',
      L2: '9주·5소경·군',
      L3: '군·현·10정·6기정'
    };
    if (els.zoomLevelValue) els.zoomLevelValue.textContent = labels[state.zoomLevel];
  }

  /* =========================================================
     텍스트 클릭 → 설명창
     ========================================================= */
  function onSvgClick(e) {
    // 팬 후 발생한 클릭이면 무시
    if (state.panMoved) {
      state.panMoved = false;
      return;
    }
    let target = e.target;
    // tspan → 부모 text로 올라가기
    while (target && target !== state.svgEl) {
      if (target.tagName === 'text' && target.classList.contains('place-text')) {
        const name = target.getAttribute('data-name');
        const category = target.getAttribute('data-category');
        const hanja = target.getAttribute('data-hanja') || '';
        // 현재 보이는지 체크 (CSS display:none이면 클릭 자체가 안 옴, 안전장치)
        if (name) {
          openDetail({ name, category, hanja, textEl: target });
        }
        return;
      }
      target = target.parentNode;
    }
  }

  function openDetail({ name, category, hanja, textEl }) {
    // 선택 강조
    if (state.selectedTextEl && state.selectedTextEl !== textEl) {
      state.selectedTextEl.classList.remove('is-selected');
    }
    if (textEl) {
      textEl.classList.add('is-selected');
      state.selectedTextEl = textEl;
    }

    const wasPanelOpen = state.panelOpen;

    // 패널 표시 (설명 모드)
    showPanel('detail');
    els.detailTitle.textContent = name;
    els.detailHanja.textContent = hanja || '';
    els.detailHanja.style.display = hanja ? '' : 'none';
    els.detailCategoryTag.textContent = CATEGORY_LABEL[category] || '';
    els.detailCategoryTag.className = 'detail-category-tag cat-' + category;

    // 클릭된 텍스트가 패널 영역에 가려진다면, 우측으로 살짝 이동
    // (패널이 새로 열린 경우에만 보정 — 이미 열려있던 경우엔 사용자 의도대로 클릭한 것)
    if (textEl && !wasPanelOpen && window.innerWidth > 640) {
      panToRevealIfHidden(textEl);
    }
  }

  function panToRevealIfHidden(textEl) {
    // 텍스트의 현재 화면 위치를 가져와 패널에 가려졌는지 판단
    try {
      const bbox = textEl.getBoundingClientRect();
      const panelWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--panel-width')) || 360;
      const textCenterX = bbox.left + bbox.width / 2;
      if (textCenterX < panelWidth + 40) {
        // 패널에 가려짐 → SVG 좌표로 환산하여 viewBox.x 보정
        const mapRect = els.map.getBoundingClientRect();
        const cvb = state.currentViewBox;
        // 화면상 (panelWidth + 80px) 위치로 이동시키려면 SVG 좌표상 얼마나 이동?
        const targetScreenX = panelWidth + 80;
        const shiftScreenX = textCenterX - targetScreenX;
        const shiftSvgX = shiftScreenX * (cvb.w / mapRect.width);
        const targetVb = {
          x: cvb.x + shiftSvgX,
          y: cvb.y,
          w: cvb.w,
          h: cvb.h
        };
        animateViewBox(targetVb, 400);
      }
    } catch (e) {
      // getBoundingClientRect 실패 시 무시
    }
  }

  /* =========================================================
     검색
     ========================================================= */
  function setupSearch() {
    let debounceTimer;
    els.searchInput.addEventListener('input', () => {
      const q = els.searchInput.value.trim();
      els.clearBtn.hidden = q.length === 0;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => renderSearchResults(q), 80);
      // 입력이 시작되면 검색 모드로
      if (state.panelMode !== 'search') showPanel('search');
    });

    els.searchInput.addEventListener('focus', () => {
      if (state.panelMode !== 'search') showPanel('search');
    });

    els.clearBtn.addEventListener('click', () => {
      els.searchInput.value = '';
      els.clearBtn.hidden = true;
      renderSearchResults('');
      els.searchInput.focus();
    });
  }

  function renderSearchResults(query) {
    const list = els.searchResults;
    list.innerHTML = '';

    if (!query) {
      els.searchEmpty.hidden = false;
      list.hidden = true;
      return;
    }

    els.searchEmpty.hidden = true;
    list.hidden = false;

    // 부분 일치 검색 (한글, 한자 모두)
    const q = query.toLowerCase();
    const matches = state.places.filter(p => {
      return p.name.toLowerCase().includes(q) || (p.hanja && p.hanja.includes(query));
    });

    if (matches.length === 0) {
      list.innerHTML = '<li class="no-results">검색 결과가 없습니다.</li>';
      return;
    }

    // 카테고리 우선순위로 정렬 (큰 단위부터)
    const catOrder = ['ju', 'sogyeong', 'geumseong', 'gun', 'hyeon', 'jeong10', 'gijeong6', 'vassal', 'neighbor'];
    matches.sort((a, b) => {
      const ai = catOrder.indexOf(a.category);
      const bi = catOrder.indexOf(b.category);
      if (ai !== bi) return ai - bi;
      return a.name.localeCompare(b.name);
    });

    // 최대 100개로 제한 (성능)
    const items = matches.slice(0, 100);
    const frag = document.createDocumentFragment();
    items.forEach(p => {
      const li = document.createElement('li');
      li.className = 'search-result-item';
      li.tabIndex = 0;
      li.innerHTML = `
        <span class="result-cat-tag result-cat-${p.category}">${CATEGORY_LABEL[p.category] || ''}</span>
        <div class="result-text">
          <div class="result-name">${highlightMatch(p.name, query)}</div>
          ${p.hanja ? `<div class="result-hanja">${p.hanja}</div>` : ''}
        </div>
      `;
      li.addEventListener('click', () => selectSearchResult(p));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') selectSearchResult(p);
      });
      frag.appendChild(li);
    });
    list.appendChild(frag);
  }

  function highlightMatch(name, query) {
    if (!query) return escapeHtml(name);
    const idx = name.toLowerCase().indexOf(query.toLowerCase());
    if (idx < 0) return escapeHtml(name);
    return (
      escapeHtml(name.slice(0, idx)) +
      '<mark>' + escapeHtml(name.slice(idx, idx + query.length)) + '</mark>' +
      escapeHtml(name.slice(idx + query.length))
    );
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function selectSearchResult(p) {
    // 1. 자동 줌인 + 중앙 이동
    const targetZoom = SEARCH_TARGET_ZOOM[p.category] || 2.0;
    flyTo(p.x, p.y, targetZoom);

    // 2. SVG에서 해당 텍스트 요소 찾아 강조
    setTimeout(() => {
      const textEl = findTextElement(p);
      openDetail({
        name: p.name,
        category: p.category,
        hanja: p.hanja,
        textEl
      });
    }, 50);
  }

  function findTextElement(place) {
    // data-name + data-category로 매칭, 좌표가 가장 가까운 것 선택
    const candidates = state.svgEl.querySelectorAll(
      `text.place-text[data-name="${CSS.escape(place.name)}"][data-category="${place.category}"]`
    );
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    // 여러 개면 (9주 大/小 같은 경우) 가장 가까운 것
    let best = candidates[0];
    let bestDist = Infinity;
    candidates.forEach(el => {
      const tf = el.getAttribute('transform') || '';
      const m = tf.match(/translate\(([^,)\s]+)[\s,]+([^)]+)\)/);
      if (!m) return;
      const x = parseFloat(m[1]);
      const y = parseFloat(m[2]);
      const dist = Math.hypot(x - place.x, y - place.y);
      if (dist < bestDist) { bestDist = dist; best = el; }
    });
    return best;
  }

  function flyTo(svgX, svgY, targetZoom) {
    const origW = state.svgOriginalViewBox.w;
    const origH = state.svgOriginalViewBox.h;
    const newW = origW / targetZoom;
    const newH = origH / targetZoom;
    // 패널이 열려 있으면 화면 중앙이 (panel + map 영역 중심)이 되도록 보정
    let centerOffsetX = 0;
    if (state.panelOpen && window.innerWidth > 640) {
      // 패널 너비(360px)만큼 좌측이 가려지므로, 지명이 패널 우측 중앙에 오게
      const mapWidth = window.innerWidth - 360;
      const offsetFraction = (180 / mapWidth);  // 절반 만큼 좌측으로
      // SVG 좌표 기준: viewBox는 SVG 좌표계이므로
      centerOffsetX = -newW * offsetFraction;
    }
    const targetVb = {
      x: svgX - newW / 2 + centerOffsetX,
      y: svgY - newH / 2,
      w: newW,
      h: newH
    };
    animateViewBox(targetVb, 700);
  }

  /* =========================================================
     UI 컨트롤
     ========================================================= */
  function setupUI() {
    // 줌 버튼
    els.zoomIn.addEventListener('click', () => zoomAt(0.5, 0.5, ZOOM_STEP));
    els.zoomOut.addEventListener('click', () => zoomAt(0.5, 0.5, 1 / ZOOM_STEP));
    els.zoomReset.addEventListener('click', () => {
      animateViewBox({ ...state.svgOriginalViewBox }, 600);
    });

    // 패널 토글 버튼 (열기/닫기 토글)
    els.panelToggleBtn.addEventListener('click', () => {
      if (state.panelOpen) {
        hidePanel();
      } else {
        showPanel('search');
        setTimeout(() => els.searchInput.focus(), 100);
      }
    });
    els.backBtn.addEventListener('click', () => showPanel('search'));

    // 레이어 토글
    els.layerBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const layer = btn.dataset.layer;
        toggleLayer(layer);
        // 모든 레이어 버튼의 UI 상태를 state와 동기화 (상호 배타로 다른 버튼도 변할 수 있음)
        syncLayerBtnsUI();
      });
    });

    // 키보드 단축키
    document.addEventListener('keydown', onKeyDown);

    // 검색
    setupSearch();

    // 레이어 버튼 UI를 state와 동기화 (HTML과 state가 어긋날 경우 안전망)
    syncLayerBtnsUI();

    // 초기 상태: 패널 닫힘
    hidePanel(true);
  }

  function onKeyDown(e) {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === '+' || e.key === '=') zoomAt(0.5, 0.5, ZOOM_STEP);
    if (e.key === '-' || e.key === '_') zoomAt(0.5, 0.5, 1 / ZOOM_STEP);
    if (e.key === '0') animateViewBox({ ...state.svgOriginalViewBox }, 500);
    if (e.key === 'Escape') {
      if (state.panelOpen) hidePanel();
      if (state.selectedTextEl) {
        state.selectedTextEl.classList.remove('is-selected');
        state.selectedTextEl = null;
      }
    }
    if (e.key === '/' || (e.ctrlKey && e.key === 'k') || (e.metaKey && e.key === 'k')) {
      e.preventDefault();
      showPanel('search');
      els.searchInput.focus();
    }
  }

  function showPanel(mode) {
    state.panelOpen = true;
    state.panelMode = mode;
    els.panel.classList.remove('collapsed');

    if (mode === 'search') {
      els.searchMode.hidden = false;
      els.detailMode.hidden = true;
      els.backBtn.hidden = true;
      // 검색어가 비어있으면 안내 표시
      renderSearchResults(els.searchInput.value.trim());
    } else if (mode === 'detail') {
      els.searchMode.hidden = true;
      els.detailMode.hidden = false;
      els.backBtn.hidden = false;
    }
  }

  function hidePanel(initial = false) {
    state.panelOpen = false;
    els.panel.classList.add('collapsed');
    if (state.selectedTextEl && !initial) {
      // 패널 닫혀도 선택은 유지하고 싶을 수 있지만, 시각적 일관성을 위해 해제
      state.selectedTextEl.classList.remove('is-selected');
      state.selectedTextEl = null;
    }
  }

  function toggleLayer(layer) {
    const wasOn = state.layers[layer];
    state.layers[layer] = !wasOn;

    // 상호 배타: 군·현 ↔ 6기정·10정
    // 사용자가 한쪽을 새로 켰다면 반대쪽을 자동으로 끔
    if (!wasOn) {
      if (layer === 'gun-hyeon' && state.layers['jeong']) {
        state.layers['jeong'] = false;
      } else if (layer === 'jeong' && state.layers['gun-hyeon']) {
        state.layers['gun-hyeon'] = false;
      }
    }

    applyLayerVisibility();
  }

  function syncLayerBtnsUI() {
    els.layerBtns.forEach(btn => {
      const layer = btn.dataset.layer;
      const active = !!state.layers[layer];
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  function applyLayerVisibility() {
    const m = els.map;
    m.setAttribute('data-layer-juboundary', state.layers['ju-boundary'] ? 'on' : 'off');
    m.setAttribute('data-layer-region', state.layers['modern-region'] ? 'on' : 'off');
    m.setAttribute('data-layer-admin', state.layers['modern-admin'] ? 'on' : 'off');
    m.setAttribute('data-layer-gunhyeon', state.layers['gun-hyeon'] ? 'on' : 'off');
    m.setAttribute('data-layer-jeong', state.layers['jeong'] ? 'on' : 'off');
    m.setAttribute('data-layer-neighbors', state.layers['neighbors'] ? 'on' : 'off');
    m.setAttribute('data-layer-vassals', state.layers['vassals'] ? 'on' : 'off');
    m.setAttribute('data-layer-balhae-border', state.layers['balhae-border'] ? 'on' : 'off');
  }

  /* =========================================================
     시작
     ========================================================= */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
