import type { TradeOffer } from '@sleeper/domain';

export function buildTradeMessage(offer: TradeOffer, tone: 'friendly' | 'direct' = 'friendly'): string {
  const give = offer.give.map(a => a.name).join(' + '), receive = offer.receive.map(a => a.name).join(' + ');
  const need = offer.partner.needImprovements[0]?.need;
  const ownNeed = offer.user.needImprovements[0]?.need;
  const fit = need ? ` It could help your ${need.position ?? 'draft'} ${need.kind === 'capital' ? 'capital' : need.kind}, while helping my ${ownNeed?.position ?? 'roster'} ${ownNeed?.kind ?? 'depth'}.` : '';
  return `${tone === 'friendly' ? 'Hey! Would you consider' : 'Trade idea:'} my ${give} for your ${receive}?${fit} ${tone === 'friendly' ? 'Open to discussing a different package if that fits your plans better.' : 'Let me know what fits your plans.'}`;
}
