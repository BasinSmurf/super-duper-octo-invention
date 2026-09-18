// Sales Tax Jurisdictions (from QB SalesTaxItem export)
// Rates are combined (state + county + city) where applicable.

export interface TaxJurisdiction {
  id: string
  name: string
  rate: number
}

export const TAX_JURISDICTIONS: TaxJurisdiction[] = [
  { id: 'no_tax', name: 'No Tax', rate: 0 },
  { id: 'nd_state', name: 'ND State Only (5%)', rate: 0.05 },
  { id: 'williston', name: 'Williston (8%)', rate: 0.08 },  // 5% state + 1% Williams + 2% Williston
  { id: 'watford_city', name: 'Watford City / McKenzie (5%)', rate: 0.05 },
  { id: 'dickinson', name: 'Dickinson (6.5%)', rate: 0.065 },
  { id: 'minot', name: 'Minot / Ward (5.5%)', rate: 0.055 },
  { id: 'williams_co', name: 'Williams County (6%)', rate: 0.06 }, // 5% state + 1% county
  { id: 'mandan', name: 'Mandan (7.25%)', rate: 0.0725 },
  { id: 'morton_co', name: 'Morton County (5.5%)', rate: 0.055 },
  { id: 'stark_co', name: 'Stark County (5%)', rate: 0.05 },
  { id: 'billings_co', name: 'Billings County (5%)', rate: 0.05 },
  { id: 'burke_co', name: 'Burke County (5%)', rate: 0.05 },
  { id: 'divide_co', name: 'Divide County (5%)', rate: 0.05 },
  { id: 'dunn_co', name: 'Dunn County (5%)', rate: 0.05 },
  { id: 'mountrail_co', name: 'Mountrail County (5%)', rate: 0.05 },
  { id: 'golden_valley_co', name: 'Golden Valley County (5%)', rate: 0.05 },
  { id: 'mt_exempt', name: 'Montana (Exempt)', rate: 0 },
]

export const DEFAULT_CC_FEE_PCT = 4
