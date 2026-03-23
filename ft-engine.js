/**
 * ft-engine.js — StockFlow Pro · Motor de Cálculo de Fichas Técnicas
 * ==========================================================================
 * Extraído de: index.html (PizzaCost — Food Cost Pro)
 *
 * REGRAS DESTE MÓDULO:
 *   ✅ Funções puras — dado o mesmo input, sempre o mesmo output
 *   ✅ Zero acesso ao DOM
 *   ✅ Zero variáveis globais externas
 *   ✅ Zero localStorage / window.*
 *   ✅ Tratamento de null, undefined, NaN, Infinity, divisão por zero
 *
 * USO:
 *   import { calcFicha, ingCostPerG, parseNum, ... } from './ft-engine.js';
 *
 *   const resultado = calcFicha(ficha, {
 *     ingredients: [...],
 *     preparos: [...],
 *     fixedCosts: [...],
 *     settings: { monthlyVolume: 1000, workingDays: 20 }
 *   });
 * ==========================================================================
 */

'use strict';

// ============================================================
//  TIPOS (documentação — sem TypeScript)
// ============================================================
//
//  Ingredient  { id, name, purchasePrice, packageWeightG, lossPercent, unit: 'g'|'kg'|'un' }
//  Preparo     { id, name, items: Item[], rawWeightG, finalWeightG }
//  FixedCost   { id, name, value }
//  Item        { id, type: 'ingredient'|'preparo', weightG }
//  Ficha       { id, productName, size, items: Item[], sellingPrice,
//                alertThreshold, includeFixedCosts }
//  Context     { ingredients: Ingredient[], preparos: Preparo[],
//                fixedCosts: FixedCost[], fichas: Ficha[],
//                settings: { monthlyVolume, workingDays,
//                            targetMargin? (% padrão p/ precoSugerido, default 30) } }
//
//  CalcResult  { varCost, fixCost, totalCost, profit, margin, markup,
//                breakeven, precoSugerido, isLoss, isAlert, isZeroPrice }


// ============================================================
//  §1  MATEMÁTICA INTERNA
//      Arredondamentos de precisão para evitar drift de ponto flutuante.
//      Privadas — não exportadas.
// ============================================================

/** Arredonda a 5 casas decimais (precisão interna de custo por grama). */
const _r5 = (v) => Math.round((_safeNum(v)) * 100000) / 100000;

/** Arredonda a 2 casas decimais (valores monetários). */
const _r2 = (v) => Math.round((_safeNum(v)) * 100) / 100;

/** Garante número finito; retorna 0 para NaN, Infinity, null, undefined. */
function _safeNum(v) {
  const n = +v;
  return isFinite(n) ? n : 0;
}


// ============================================================
//  §2  PARSE DE ENTRADA
// ============================================================

/**
 * Converte string de input do usuário em número.
 * Suporta formato BR (1.234,56) e EN (1234.56).
 *
 * @param   {string|number} s
 * @returns {number}  0 se inválido
 */
export function parseNum(s) {
  const str = String(s == null ? '' : s).trim();
  if (!str) return 0;

  let normalized = str;

  // Formato BR: dígitos, pontos de milhar, vírgula decimal → "1.234,56"
  if (/^\d{1,3}(\.\d{3})*(,\d+)?$/.test(normalized)) {
    normalized = normalized.replace(/\./g, '').replace(',', '.');
  } else {
    // Formato simples com vírgula: "12,5" → "12.5"
    normalized = normalized.replace(',', '.');
  }

  const result = parseFloat(normalized);
  return isFinite(result) ? result : 0;
}


// ============================================================
//  §3  CUSTO DE INGREDIENTE
// ============================================================

/**
 * Custo por grama (ou por unidade) de um ingrediente,
 * considerando perda percentual.
 *
 * Função pura — não acessa estado externo.
 *
 * @param   {Ingredient} ing
 * @returns {number}  custo por grama (ou por unidade se unit='un')
 */
export function ingCostPerG(ing) {
  if (!ing) return 0;

  const price  = _safeNum(ing.purchasePrice);
  const weight = _safeNum(ing.packageWeightG);

  // Sem preço ou sem peso → custo zero (ingrediente não precificado)
  if (price <= 0 || weight <= 0) return 0;

  const baseCost = _r5(price / weight);

  // Unidade (caixas, latas) → sem perda percentual aplicável
  if (ing.unit === 'un') return baseCost;

  const loss = _safeNum(ing.lossPercent);
  if (loss <= 0 || loss >= 100) return baseCost;

  // Custo efetivo após perda: divide pelo fator de aproveitamento
  // Ex: 10% perda → aproveitamento 90% → custo /= 0.90
  return _r5(baseCost / (1 - loss / 100));
}


// ============================================================
//  §4  CUSTO DE PREPARO
// ============================================================

/**
 * Custo total de um preparo (soma de todos os seus itens).
 *
 * @param   {Preparo}  prep
 * @param   {Context}  ctx
 * @param   {Set}      [visited]  — anti-recursão (uso interno)
 * @returns {number}
 */
export function prepTotalCost(prep, ctx, visited) {
  if (!prep || !Array.isArray(prep.items)) return 0;
  const vis = visited || new Set();
  return _r5(
    prep.items.reduce((acc, item) => _r5(acc + itemCost(item, ctx, vis)), 0)
  );
}

/**
 * Custo por grama do produto FINAL de um preparo (após rendimento).
 *
 * @param   {Preparo}  prep
 * @param   {Context}  ctx
 * @param   {Set}      [visited]  — anti-recursão
 * @returns {number}
 */
export function prepCostPerG(prep, ctx, visited) {
  if (!prep) return 0;
  const finalWeight = _safeNum(prep.finalWeightG);
  if (finalWeight <= 0) return 0;
  return _r5(prepTotalCost(prep, ctx, visited) / finalWeight);
}


// ============================================================
//  §5  CUSTO DE ITEM (ingrediente OU preparo aninhado)
// ============================================================

/**
 * Custo de um item dentro de uma receita ou preparo.
 * Resolve automaticamente se é ingrediente ou preparo aninhado.
 * Detecta e bloqueia referências circulares.
 *
 * @param   {Item}     item
 * @param   {Context}  ctx
 * @param   {Set}      [visited]  — conjunto de IDs de preparos já visitados
 * @returns {number}
 */
export function itemCost(item, ctx, visited) {
  // Rejeita: null, item sem id, peso zero/negativo/NaN
  if (!item || !item.id || !(_safeNum(item.weightG) > 0)) return 0;

  const vis = visited || new Set();
  const weight = _safeNum(item.weightG);

  if (item.type === 'ingredient') {
    const ing = _findById(ctx?.ingredients, item.id);
    if (!ing) return 0;
    return _r5(ingCostPerG(ing) * weight);
  }

  if (item.type === 'preparo') {
    // Bloqueia ciclo (A→B→A)
    if (vis.has(item.id)) return 0;

    const prep = _findById(ctx?.preparos, item.id);
    if (!prep) return 0;

    const nextVis = new Set(vis);
    nextVis.add(item.id);

    return _r5(prepCostPerG(prep, ctx, nextVis) * weight);
  }

  return 0;
}


// ============================================================
//  §6  CUSTOS FIXOS
// ============================================================

/**
 * Soma total dos custos fixos mensais.
 *
 * @param   {FixedCost[]} fixedCosts
 * @returns {number}
 */
export function totalFixedCosts(fixedCosts) {
  if (!Array.isArray(fixedCosts) || fixedCosts.length === 0) return 0;
  return _r5(
    fixedCosts.reduce((acc, c) => _r5(acc + _safeNum(c?.value)), 0)
  );
}

/**
 * Custo fixo rateado por unidade produzida.
 *
 * @param   {FixedCost[]} fixedCosts
 * @param   {number}      monthlyVolume  — unidades produzidas por mês
 * @returns {number}  0 se monthlyVolume ≤ 0
 */
export function fixedCostPerUnit(fixedCosts, monthlyVolume) {
  const vol = _safeNum(monthlyVolume);
  if (vol <= 0) return 0;
  return _r5(totalFixedCosts(fixedCosts) / vol);
}


// ============================================================
//  §7  CÁLCULO PRINCIPAL — FICHA TÉCNICA
// ============================================================

/**
 * Calcula todos os indicadores financeiros de uma ficha técnica.
 *
 * Entrada (ficha):
 *   { items, sellingPrice, alertThreshold, includeFixedCosts }
 *
 * Contexto:
 *   { ingredients, preparos, fixedCosts, settings: { monthlyVolume } }
 *
 * Saída (CalcResult):
 *   {
 *     varCost,       — custo variável (ingredientes + preparos)
 *     fixCost,       — custo fixo rateado
 *     totalCost,     — varCost + fixCost
 *     profit,        — sellingPrice - totalCost
 *     margin,        — % de lucro sobre preço de venda
 *     markup,        — fator preço/custo, limitado a 999×
 *     breakeven,     — preço mínimo para cobrir custo (= totalCost)
 *     precoSugerido, — preço para ctx.settings.targetMargin% (padrão: 30%)
 *     isLoss,        — true se lucro negativo com preço > 0
 *     isAlert,       — true se margin <= alertThreshold (% configurado na ficha)
 *     isZeroPrice,   — true se sellingPrice = 0 (produto sem preço)
 *   }
 *
 * @param   {Ficha}   ficha
 * @param   {Context} ctx
 * @returns {CalcResult|null}  null se ficha for inválida
 */
export function calcFicha(ficha, ctx) {
  if (!ficha) return null;

  const items    = Array.isArray(ficha.items) ? ficha.items : [];
  const settings = ctx?.settings || {};
  const fcpu     = ficha.includeFixedCosts
    ? fixedCostPerUnit(ctx?.fixedCosts, settings.monthlyVolume)
    : 0;

  // Custo variável: soma de todos os itens da receita
  const varCost   = _r5(items.reduce((acc, it) => _r5(acc + itemCost(it, ctx)), 0));
  const fixCost   = _r5(fcpu);
  const totalCost = _r5(varCost + fixCost);

  const price  = _safeNum(ficha.sellingPrice);
  const profit = _r5(price - totalCost);

  // Margem sobre preço de venda (evita divisão por zero)
  const margin = price > 0 ? _r2((profit / price) * 100) : 0;

  // Markup sobre custo (evita divisão por zero e valores absurdos)
  // Limitado a 999× — acima disso o dado é ruído, não informação útil
  const markupRaw = totalCost > 0 ? price / totalCost : 0;
  const markup    = _r2(Math.min(_safeNum(markupRaw), 999));

  // Preço mínimo para equilíbrio = custo total
  const breakeven = totalCost;

  // Preço sugerido para a margem-alvo configurada (padrão: 30%).
  // Casos tratados explicitamente, sem clamp que distorce valores extremos:
  //   totalCost = 0      → 0 (sem custo, sugestão não faz sentido)
  //   targetMargin >= 100 → 0 (matematicamente impossível: divisor seria ≤ 0)
  //   targetMargin <= 0   → totalCost (margem 0% = preço igual ao custo, breakeven exato)
  //   caso normal         → fórmula markup reverso
  const targetMargin  = settings.targetMargin != null ? _safeNum(settings.targetMargin) : 30;
  const precoSugerido = totalCost <= 0
    ? 0
    : targetMargin >= 100
      ? 0
      : targetMargin <= 0
        ? totalCost
        : _r2(totalCost / (1 - targetMargin / 100));

  const isZeroPrice = price === 0;
  const isLoss      = profit < 0 && price > 0;

  // isAlert — baseado em MARGEM (%), não em custo absoluto.
  // Semântica: alerta quando a margem real cai abaixo do limite configurado.
  // alertThreshold = 0 desativa o alerta.
  // Com preço = 0 não há margem calculável → não alerta.
  //
  // ⚠ NOTA DE COMPATIBILIDADE: dados criados com a versão anterior
  //   armazenavam alertThreshold como valor absoluto de custo (ex: R$20).
  //   Com esta mudança, o mesmo campo passa a representar % de margem
  //   mínima (ex: 20 → alerta se margem < 20%).
  //   Para migrar dados legados: se alertThreshold > 0 e a ficha tem
  //   sellingPrice, recalcule: alertThreshold = (1 - oldThreshold/price)*100
  const alertThreshold = _safeNum(ficha.alertThreshold);
  const isAlert = alertThreshold > 0 && price > 0 && margin <= alertThreshold;

  return {
    varCost,
    fixCost,
    totalCost,
    profit,
    margin,
    markup,
    breakeven,
    precoSugerido,
    isLoss,
    isAlert,
    isZeroPrice,
  };
}


// ============================================================
//  §8  PRECIFICAÇÃO REVERSA
// ============================================================

/**
 * Calcula o preço de venda necessário para atingir uma margem desejada.
 *
 *   precoVenda = totalCost / (1 - margemDesejada / 100)
 *
 * @param   {number} totalCost       — custo total da ficha
 * @param   {number} margemDesejada  — margem em % (ex: 40 para 40%)
 * @returns {number}  0 se custo = 0 ou margem ≥ 100
 */
export function calcPrecoParaMargem(totalCost, margemDesejada) {
  const cost  = _safeNum(totalCost);
  const marg  = _safeNum(margemDesejada);
  if (cost <= 0 || marg >= 100) return 0;
  return _r2(cost / (1 - marg / 100));
}

/**
 * Calcula a margem resultante de um dado preço de venda sobre um custo.
 *
 * @param   {number} totalCost
 * @param   {number} sellingPrice
 * @returns {number}  margem em % — 0 se preço = 0
 */
export function calcMargemParaPreco(totalCost, sellingPrice) {
  const price = _safeNum(sellingPrice);
  const cost  = _safeNum(totalCost);
  if (price <= 0) return 0;
  return _r2(((price - cost) / price) * 100);
}


// ============================================================
//  §9  BREAKDOWN DE ITENS (para exibição de detalhes)
// ============================================================

/**
 * Retorna o custo e metadados de cada item da ficha,
 * resolvendo nomes de ingredientes e preparos a partir do contexto.
 *
 * @param   {Ficha}   ficha
 * @param   {Context} ctx
 * @returns {Array<{ name, type, detail, cost }>}
 */
export function fichaItemBreakdown(ficha, ctx) {
  if (!ficha || !Array.isArray(ficha.items)) return [];

  return ficha.items
    .filter((item) => item != null)   // guarda contra null/undefined no array
    .map((item) => {
    const cost = itemCost(item, ctx);
    let name, type, detail;

    if (item.type === 'ingredient') {
      const ing = _findById(ctx?.ingredients, item.id);
      name   = ing ? ing.name : '(ingrediente não encontrado)';
      type   = 'Ingrediente';
      detail = ing
        ? (ing.unit === 'un' ? `${item.weightG} un` : _fmtGrams(item.weightG))
        : '';
    } else {
      const prep = _findById(ctx?.preparos, item.id);
      name   = prep ? prep.name : '(preparo não encontrado)';
      type   = 'Preparo';
      detail = _fmtGrams(item.weightG);
    }

    return { name, type, detail, cost };
  });
}


// ============================================================
//  §10  DASHBOARD / AGREGAÇÕES
// ============================================================

/**
 * Calcula métricas agregadas de todas as fichas com preço definido.
 *
 * @param   {Context} ctx
 * @returns {object|null}  null se não há fichas precificadas
 */
export function calcDashboard(ctx) {
  const fichas = Array.isArray(ctx?.fichas) ? ctx.fichas : [];

  // calcFicha retorna null para fichas inválidas — filtrar antes de qualquer acesso
  const all = fichas
    .map((f) => ({ ficha: f, calc: calcFicha(f, ctx) }))
    .filter((x) => x.calc !== null);                          // FIX: guard null

  // Apenas fichas com preço definido contribuem para os agregados
  const priced = all.filter((x) => x.ficha.sellingPrice > 0);

  if (priced.length === 0) return null;

  const count  = priced.length;
  const avgOf  = (key) => _r2(priced.reduce((s, x) => s + x.calc[key], 0) / count);
  const avgPOf = (key) => _r2(priced.reduce((s, x) => s + x.ficha[key],  0) / count);

  const avgCost    = avgOf('totalCost');
  const avgProfit  = avgOf('profit');
  const avgMargin  = avgOf('margin');
  const avgPrice   = avgPOf('sellingPrice');
  const avgVarCost = avgOf('varCost');

  // Ponto de equilíbrio: TFC / margem de contribuição média por unidade
  const tfc          = totalFixedCosts(ctx?.fixedCosts);
  const contribution = _safeNum(avgPrice) - _safeNum(avgVarCost);
  const breakevenUnits = contribution > 0
    ? Math.ceil(tfc / contribution)
    : null;

  const alerts   = all.filter((x) => x.calc.isLoss || x.calc.isAlert);
  const byProfit = [...priced].sort((a, b) => b.calc.profit - a.calc.profit);
  const byCost   = [...priced].sort((a, b) => b.calc.totalCost - a.calc.totalCost);
  const byMargin = [...priced].sort((a, b) => b.calc.margin - a.calc.margin);

  return {
    avgCost,
    avgProfit,
    avgMargin,
    avgPrice,
    avgVarCost,
    tfc,
    breakevenUnits,
    alerts,
    byProfit,
    byCost,
    byMargin,
  };
}


// ============================================================
//  §11  VALIDAÇÃO DE ENTIDADES
// ============================================================

/**
 * Valida dados de ingrediente antes de salvar.
 *
 * @param   {object} data
 * @returns {object}  mapa de erros { campo: 'mensagem' } — vazio se válido
 */
export function validateIngredient(data) {
  const errs = {};
  const d    = data || {};

  if (!d.name || !String(d.name).trim())
    errs.name = 'Nome é obrigatório';

  if (_safeNum(d.purchasePrice) < 0)
    errs.purchasePrice = 'Não pode ser negativo';

  const weight = _safeNum(d.packageWeightG);
  if (!weight || weight <= 0)
    errs.packageWeightG = 'Peso deve ser maior que 0';

  const loss = _safeNum(d.lossPercent);
  if (loss < 0 || loss >= 100)
    errs.lossPercent = 'Perda deve estar entre 0 e 99';

  return errs;
}

/**
 * Valida dados de preparo, incluindo detecção de referências circulares.
 *
 * @param   {object}   data      — dados do preparo (pode ter id='__new__')
 * @param   {Preparo[]} preparos — lista completa de preparos (para checar ciclos)
 * @returns {object}  mapa de erros
 */
export function validatePreparo(data, preparos) {
  const errs = {};
  const d    = data || {};

  if (!d.name || !String(d.name).trim())
    errs.name = 'Nome é obrigatório';

  if (!_safeNum(d.finalWeightG) || _safeNum(d.finalWeightG) <= 0)
    errs.finalWeightG = 'Rendimento deve ser maior que 0';

  if (Array.isArray(d.items)) {
    const selfId = d.id || '__new__';

    const hasCircular = (prepId, visited) => {
      if (visited.has(prepId)) return true;
      const prep = _findById(preparos, prepId);
      if (!prep || !Array.isArray(prep.items)) return false;
      const next = new Set(visited);
      next.add(prepId);
      return prep.items.some(
        (it) => it.type === 'preparo' && hasCircular(it.id, next)
      );
    };

    const rootVisited = new Set([selfId]);
    const circular = d.items.some((it) => {
      if (!it || it.type !== 'preparo') return false;
      if (it.id === selfId) return true;          // referência direta a si mesmo
      return hasCircular(it.id, rootVisited);       // referência indireta
    });

    if (circular)
      errs.items = 'Referência circular — um preparo não pode depender de si mesmo';
  }

  return errs;
}

/**
 * Valida dados de ficha técnica.
 *
 * @param   {object} data
 * @returns {object}  mapa de erros
 */
export function validateFicha(data) {
  const errs = {};
  const d    = data || {};

  if (!d.productName || !String(d.productName).trim())
    errs.productName = 'Nome do produto é obrigatório';

  if (!d.size)
    errs.size = 'Tamanho é obrigatório';

  if (_safeNum(d.sellingPrice) < 0)
    errs.sellingPrice = 'Preço não pode ser negativo';

  if (_safeNum(d.alertThreshold) < 0)
    errs.alertThreshold = 'Limite de alerta não pode ser negativo';

  return errs;
}


// ============================================================
//  §12  UTILITÁRIOS INTERNOS (privados — não exportados)
// ============================================================

/** Busca entidade por id num array com segurança. */
function _findById(arr, id) {
  if (!Array.isArray(arr) || !id) return null;
  return arr.find((item) => item?.id === id) || null;
}

/** Formata gramas: ≥1000g exibe em kg. */
function _fmtGrams(v) {
  const gv = _safeNum(v);
  return gv >= 1000 ? (gv / 1000).toFixed(2) + 'kg' : gv + 'g';
}


// ============================================================
//  §13  EXPORT DE CONVENIÊNCIA — contexto completo
// ============================================================

/**
 * Cria um contexto válido a partir de um estado da aplicação.
 * Útil para adaptar o estado do StockFlow Pro sem duplicar código.
 *
 * @param   {object} state  — objeto de estado da aplicação
 * @returns {Context}
 */
export function buildContext(state) {
  const s = state || {};
  return {
    ingredients : Array.isArray(s.ingredients) ? s.ingredients : [],
    preparos    : Array.isArray(s.preparos)    ? s.preparos    : [],
    fixedCosts  : Array.isArray(s.fixedCosts)  ? s.fixedCosts  : [],
    fichas      : Array.isArray(s.fichas)       ? s.fichas      : [],
    settings    : {
      monthlyVolume : _safeNum(s.settings?.monthlyVolume) > 0
                        ? _safeNum(s.settings.monthlyVolume)
                        : 1000,
      workingDays   : _safeNum(s.settings?.workingDays) > 0
                        ? _safeNum(s.settings.workingDays)
                        : 20,
      // targetMargin: null/undefined → indefinido (calcFicha usa default 30).
      // Valor 0 é preservado explicitamente (significa "sem margem mínima").
      targetMargin  : s.settings?.targetMargin != null
                        ? _safeNum(s.settings.targetMargin)
                        : undefined,
    },
  };
}
