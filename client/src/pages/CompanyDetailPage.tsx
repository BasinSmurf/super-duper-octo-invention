import { useState, useEffect, useCallback } from 'react'
import { CustomerDescriptions } from '@/components/CustomerDescriptions'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { hasPermission } from '@/lib/permissions'
import { type RentalBom, type RentalBomProduct, type RentalBomType, RENTAL_EQUIPMENT_CATEGORIES, EQUIP_CAT_LABEL, BOM_TYPE_LABELS, bomDisplayName } from '@/lib/rentalBom'
import { formatCalendarDate, todayKey } from '@/lib/dates'
import {
  ArrowLeft,
  Building2,
  MapPin,
  Phone,
  Mail,
  Globe,
  Users,
  Receipt,
  Tag,
  ChevronDown,
  ChevronUp,
  Loader2,
  ExternalLink,
  CreditCard,
  FileText,
  Pencil,
  X,
  Check,
  Plus,
  Save,
  Trash2,
  AlertTriangle,
  Ban,
  ShieldAlert,
  CheckCircle2,
  Package,
} from 'lucide-react'

// ---- Types ----
interface Contact {
  id: string
  name: string
  title: string | null
  phone: string | null
  email: string | null
  role: string
  isPrimary: boolean
  isActive: boolean
}

// Where a profile's AFE / cost center come from: the fixed default, or the ticket's well/pad.
type BillingFieldSource = 'fixed' | 'location'

interface BillingProfile {
  id: string
  billingLevel: string
  enverusEnabled: boolean
  enverusReceiptMode: string
  enverusInvoiceMode: string
  buyerDuns: string | null
  buyerDunsPlus4: string | null
  buyerCode: string | null
  buyerSiteUuid: string | null
  supplierDuns: string | null
  supplierSiteDunsPlus4: string | null
  stackedBillingEnabled: boolean
  stackedBillingGroupBy: string | null
  stackedBillingPeriod: string | null
  stackedBillingFiscalMonthStart: number | null
  defaultOrderedByName: string | null
  defaultAfeNumber: string | null
  defaultCostCenter: string | null
  afeNumberSource: BillingFieldSource
  costCenterSource: BillingFieldSource
  buyerSiteSource: BillingFieldSource
  buyerDepartmentSource: BillingFieldSource
  defaultBuyerDepartment: string | null
  defaultPoNumber: string | null
  defaultServiceApprover: string | null
  defaultPriceBookNumber: string | null
  facilityCodeAdfKey: string | null
  defaultAdditionalDataFields: { itemID?: string; code?: string; name?: string; value: string }[] | null
  requiresPo: boolean
  requiresAfe: boolean
  requiresCostCenter: boolean
  requiresBuyerSite: boolean
  requiresBuyerDepartment: boolean
  appliesToTicketTypes: string[] | null
  appliesToDivisions: string[] | null
  approvalRequired: string
  approvalThresholdAmount: string | null
  signatureRequired: string
  signatureApprovers: { name: string; email: string }[] | null
  isActive: boolean
  effectiveFrom: string
  effectiveTo: string | null
  notes: string | null
}

interface OperatorAlias {
  id: string
  aliasName: string
  source: string | null
}

interface ChildCompany {
  id: string
  name: string
  companyType: string
  isActive: boolean
  padCount?: number
  wellCount?: number
  assignedFieldNames?: string[]
}

interface CompanyDetail {
  id: string
  name: string
  legalName: string | null
  companyType: string
  isActive: boolean
  // Cash/Card-only customer: pays at time of service, no net-terms billing.
  cashCcOnly: boolean
  // AR credit hold: blocks new tickets + shop equipment returns. Separate from
  // isActive — a held customer stays visible so staff see why they're blocked.
  creditHold: boolean
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  phone: string | null
  email: string | null
  website: string | null
  paymentTerms: string | null
  dueDateOffset: number | null
  priceBookNumber: string | null
  attachFieldTicket: boolean
  attachInvoice: boolean
  afeLabel: string | null
  poLabel: string | null
  woLabel: string | null
  costCenterLabel: string | null
  qbCustomerListId: string | null
  qbCustomerFullName: string | null
  qbPriceLevel: string | null
  qbPriceLevelId: string | null
  // Wave 5 5C — admin-assigned price level. Drives per-line pricing
  // adjustments at invoice generation time.
  assignedPriceLevel?: {
    id: string
    name: string
    qbListId: string
    isActive: boolean
    _count?: { items: number }
  } | null
  qbSyncStatus: string | null
  // ND sales-tax exemption (resale / direct-pay / government cert). When set,
  // invoice generation defaults all this customer's lines non-taxable.
  taxExempt: boolean
  taxExemptCertNumber: string | null
  createdAt: string
  updatedAt: string
  parentCompany: { id: string; name: string } | null
  childCompanies: ChildCompany[]
  operatorAliases: OperatorAlias[]
  billingProfiles: BillingProfile[]
  contacts: Contact[]
  rentalBoms: RentalBom[]
}

interface BomDraft {
  bomType: RentalBomType
  id?: string
  // Tells this variant apart from the customer's other packages of the same
  // type on the dispatch picker ("w/ gas detection", "no monitors").
  name: string
  isDefault: boolean
  manned: boolean
  includedTechs: string
  notes: string
  // The QB item the package bills as. Without it the package can't reach this
  // customer's price level (the invoice resolver matches on qbItemListId), so
  // it stays descriptive and nothing charges for the baseline.
  packageProductId: string
  // Per row, the item an OVERAGE of that row bills as — blank is fine, the row
  // still counts toward the deploy-diff, it just can't auto-price the extra.
  items: { equipmentCategory: string; label: string; qty: number; productId: string }[]
}

interface ContactDraft {
  name: string
  title: string
  phone: string
  email: string
  role: string
  isPrimary: boolean
}

const TYPE_LABELS: Record<string, string> = {
  operator: 'Operator',
  service_company: 'Service Company',
  parent_only: 'Parent Only',
  vendor: 'Vendor',
  other: 'Other',
}

const ROLE_LABELS: Record<string, string> = {
  primary: 'Primary',
  billing: 'Billing',
  field: 'Field',
  pumper: 'Pumper',
  office: 'Office',
  other: 'Other',
}

const CONTACT_ROLES = ['primary', 'billing', 'field', 'pumper', 'office', 'other']
const COMPANY_TYPES = ['operator', 'service_company', 'parent_only', 'vendor', 'other']

// Billing profile enums
const BILLING_LEVELS = [
  { value: 'company', label: 'Company' },
  { value: 'pad', label: 'Pad' },
  { value: 'well', label: 'Well' },
  { value: 'facility', label: 'Facility' },
  { value: 'field', label: 'Field' },
]
const RECEIPT_MODES = [
  { value: 'none', label: 'None' },
  { value: 'openinvoice', label: 'OpenInvoice' },
  { value: 'openticket', label: 'OpenTicket' },
  { value: 'both', label: 'Both' },
]
const INVOICE_MODES = [
  { value: 'none', label: 'None' },
  { value: 'openinvoice_json', label: 'OpenInvoice JSON' },
  { value: 'openinvoice_pidx', label: 'OpenInvoice PIDX' },
]
const APPROVAL_OPTIONS = [
  { value: 'never', label: 'Never' },
  { value: 'always', label: 'Always' },
  { value: 'threshold', label: 'Over Threshold' },
]
const STACKED_PERIODS = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'custom', label: 'Custom' },
]

interface BillingProfileDraft {
  billingLevel: string
  isActive: boolean
  effectiveFrom: string
  effectiveTo: string
  enverusEnabled: boolean
  enverusReceiptMode: string
  enverusInvoiceMode: string
  buyerDuns: string
  buyerDunsPlus4: string
  buyerCode: string
  buyerSiteUuid: string
  supplierDuns: string
  supplierSiteDunsPlus4: string
  stackedBillingEnabled: boolean
  stackedBillingGroupBy: string
  stackedBillingPeriod: string
  stackedBillingFiscalMonthStart: string
  defaultOrderedByName: string
  defaultAfeNumber: string
  defaultCostCenter: string
  afeNumberSource: BillingFieldSource
  costCenterSource: BillingFieldSource
  buyerSiteSource: BillingFieldSource
  buyerDepartmentSource: BillingFieldSource
  defaultBuyerDepartment: string
  defaultPoNumber: string
  defaultServiceApprover: string
  defaultPriceBookNumber: string
  // Relabeled line-field defaults + per-buyer display labels (gap #1b)
  defaultMajor: string
  defaultMinor: string
  labelAfe: string
  labelCostCenter: string
  labelMajor: string
  labelMinor: string
  facilityCodeAdfKey: string
  // `_extra` preserves any keys the editor doesn't surface (e.g. COP's
  // `adeFieldType`) so a round-trip edit doesn't silently drop them.
  defaultAdditionalDataFields: { name: string; itemID: string; code: string; value: string; _extra?: Record<string, any> }[]
  requiresPo: boolean
  requiresAfe: boolean
  requiresCostCenter: boolean
  requiresBuyerSite: boolean
  requiresBuyerDepartment: boolean
  appliesToTicketTypes: string[]
  appliesToDivisions: string[]
  approvalRequired: string
  approvalThresholdAmount: string
  signatureRequired: string
  signatureApprovers: { name: string; email: string }[]
  notes: string
}

const emptyProfileDraft: BillingProfileDraft = {
  billingLevel: 'company',
  isActive: true,
  effectiveFrom: todayKey(),
  effectiveTo: '',
  enverusEnabled: false,
  enverusReceiptMode: 'none',
  enverusInvoiceMode: 'none',
  buyerDuns: '',
  buyerDunsPlus4: '',
  buyerCode: '',
  buyerSiteUuid: '',
  supplierDuns: '016937650',
  supplierSiteDunsPlus4: '',
  stackedBillingEnabled: false,
  stackedBillingGroupBy: '',
  stackedBillingPeriod: 'monthly',
  stackedBillingFiscalMonthStart: '',
  defaultOrderedByName: '',
  defaultAfeNumber: '',
  defaultCostCenter: '',
  afeNumberSource: 'fixed',
  costCenterSource: 'fixed',
  buyerSiteSource: 'fixed',
  buyerDepartmentSource: 'fixed',
  defaultBuyerDepartment: '',
  defaultPoNumber: '',
  defaultServiceApprover: '',
  defaultPriceBookNumber: '',
  defaultMajor: '',
  defaultMinor: '',
  labelAfe: '',
  labelCostCenter: '',
  labelMajor: '',
  labelMinor: '',
  facilityCodeAdfKey: '',
  defaultAdditionalDataFields: [],
  requiresPo: false,
  requiresAfe: false,
  requiresCostCenter: false,
  requiresBuyerSite: false,
  requiresBuyerDepartment: false,
  appliesToTicketTypes: [],
  appliesToDivisions: [],
  approvalRequired: 'never',
  approvalThresholdAmount: '',
  signatureRequired: 'none',
  signatureApprovers: [],
  notes: '',
}

function formatDate(d: string | null): string {
  if (!d) return '---'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const emptyContact: ContactDraft = { name: '', title: '', phone: '', email: '', role: 'field', isPrimary: false }

export function CompanyDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const canEdit = hasPermission(user?.role, 'customers:manage')

  const [company, setCompany] = useState<CompanyDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedProfile, setExpandedProfile] = useState<string | null>(null)

  // Edit state for company info
  const [editingInfo, setEditingInfo] = useState(false)
  const [infoSaving, setInfoSaving] = useState(false)
  const [togglingActive, setTogglingActive] = useState(false)
  const [togglingCreditHold, setTogglingCreditHold] = useState(false)
  const [infoDraft, setInfoDraft] = useState<Record<string, any>>({})

  // Wave 5 5C — assignable price levels for the dropdown on the Billing
  // Configuration card. Loaded once on mount; refreshed when the user
  // assigns one (so the new selection's display info is fresh).
  const [priceLevelOptions, setPriceLevelOptions] = useState<Array<{
    id: string
    name: string
    qbListId: string
    qbCustomerName: string | null
    itemCount: number
    lastSyncedAt: string | null
  }>>([])
  const [savingPriceLevel, setSavingPriceLevel] = useState(false)
  const [savingTaxExempt, setSavingTaxExempt] = useState(false)

  // Rental BOMs — the baseline gear a customer's flat rate covers. Edit gated
  // on billing:profiles (AR files agreements); field supers view only.
  const [editingBom, setEditingBom] = useState<BomDraft | null>(null)
  const [bomSaving, setBomSaving] = useState(false)
  // Catalog for the BOM's product bindings. Loaded lazily the first time an
  // editor opens — this page is mostly read, and it's a big list.
  const [bomProducts, setBomProducts] = useState<RentalBomProduct[]>([])

  // Contact CRUD
  const [editingContactId, setEditingContactId] = useState<string | null>(null)
  const [contactDraft, setContactDraft] = useState<ContactDraft>(emptyContact)
  const [addingContact, setAddingContact] = useState(false)
  const [contactSaving, setContactSaving] = useState(false)

  // Billing Profile CRUD
  const canEditBilling = hasPermission(user?.role, 'billing:profiles')
  const canEditRentalPackages = hasPermission(user?.role, 'rentals:edit_packages')
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null)
  const [addingProfile, setAddingProfile] = useState(false)
  const [profileDraft, setProfileDraft] = useState<BillingProfileDraft>(emptyProfileDraft)
  const [profileSaving, setProfileSaving] = useState(false)

  // Operator Transfer
  const [transferOpen, setTransferOpen] = useState(false)
  const [transferSourceSearch, setTransferSourceSearch] = useState('')
  const [transferSourceResults, setTransferSourceResults] = useState<Array<{ id: string; name: string }>>([])
  const [transferSource, setTransferSource] = useState<{ id: string; name: string } | null>(null)
  const [transferNotes, setTransferNotes] = useState('')
  const [transferring, setTransferring] = useState(false)
  const [opStats, setOpStats] = useState<{ pads: number; wells: number } | null>(null)

  const loadCompany = useCallback(async () => {
    if (!id) return
    setLoading(true)
    setError(null)
    try {
      const data = await api.get<CompanyDetail>(`/companies/${id}`)
      setCompany(data)
    } catch (e: any) {
      setError(e.message || 'Failed to load company')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { loadCompany() }, [loadCompany])

  // Wave 5 5C — load assignable price levels once, fed into the dropdown
  // on the Billing Configuration card. Only fetched when the user is
  // permitted to edit, since they're the only ones who'd see/use it.
  useEffect(() => {
    if (!canEdit) return
    api.get<{ data: typeof priceLevelOptions }>('/companies/price-levels')
      .then(res => setPriceLevelOptions(res.data || []))
      .catch(() => setPriceLevelOptions([]))
  }, [canEdit])

  async function handleSetPriceLevel(qbPriceLevelId: string | null) {
    if (!company) return
    setSavingPriceLevel(true)
    try {
      await api.put(`/companies/${company.id}`, { qbPriceLevelId })
      await loadCompany()
    } catch (e: any) {
      alert(e?.message || 'Failed to update price level')
    } finally {
      setSavingPriceLevel(false)
    }
  }

  async function handleSetTaxExempt(patch: { taxExempt?: boolean; taxExemptCertNumber?: string | null }) {
    if (!company) return
    setSavingTaxExempt(true)
    try {
      await api.put(`/companies/${company.id}`, patch)
      await loadCompany()
    } catch (e: any) {
      alert(e?.message || 'Failed to update tax exemption')
    } finally {
      setSavingTaxExempt(false)
    }
  }

  // Pull the active catalog once an editor is open, so AR can bind the package
  // (and each row's overage) to a real QB item.
  useEffect(() => {
    if (!editingBom || bomProducts.length) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await api.get<{ data: RentalBomProduct[] }>('/products?active=true&limit=2000')
        if (!cancelled) setBomProducts(res?.data || [])
      } catch {
        if (!cancelled) setBomProducts([])
      }
    })()
    return () => { cancelled = true }
  }, [editingBom, bomProducts.length])

  // ---- Rental BOM CRUD ----
  function startAddBom(bomType: RentalBomType) {
    setEditingBom({
      bomType,
      name: '',
      // The first package of a type is its default either way (the API settles
      // that); a later variant only takes over when AR ticks it.
      isDefault: !company?.rentalBoms?.some(b => b.bomType === bomType),
      manned: bomType !== 'unmanned',
      includedTechs: '0',
      notes: '',
      packageProductId: '',
      items: [],
    })
  }

  function startEditBom(bom: RentalBom) {
    setEditingBom({
      bomType: bom.bomType,
      id: bom.id,
      name: bom.name || '',
      isDefault: !!bom.isDefault,
      manned: bom.manned,
      includedTechs: String(bom.includedTechs ?? 0),
      notes: bom.notes || '',
      packageProductId: bom.packageProductId || '',
      items: bom.items.map(i => ({
        equipmentCategory: i.equipmentCategory,
        label: i.label || '',
        qty: i.qty,
        productId: i.productId || '',
      })),
    })
  }

  async function saveBom() {
    if (!company || !editingBom) return
    setBomSaving(true)
    try {
      const payload = {
        bomType: editingBom.bomType,
        name: editingBom.name.trim() || null,
        isDefault: editingBom.isDefault,
        manned: editingBom.manned,
        includedTechs: parseInt(editingBom.includedTechs) || 0,
        notes: editingBom.notes || null,
        packageProductId: editingBom.packageProductId || null,
        items: editingBom.items
          .filter(i => i.equipmentCategory)
          .map((i, idx) => ({
            equipmentCategory: i.equipmentCategory,
            label: i.label || null,
            qty: i.qty > 0 ? i.qty : 1,
            sortOrder: idx,
            productId: i.productId || null,
          })),
      }
      if (editingBom.id) {
        await api.put(`/companies/${company.id}/rental-boms/${editingBom.id}`, payload)
      } else {
        await api.post(`/companies/${company.id}/rental-boms`, payload)
      }
      setEditingBom(null)
      await loadCompany()
    } catch (e: any) {
      alert(e?.message || 'Failed to save rental package')
    } finally {
      setBomSaving(false)
    }
  }

  async function deleteBom(bom: RentalBom) {
    if (!company) return
    if (!window.confirm(`Delete the ${bomDisplayName(bom)} rental package for ${company.name}?\n\nRentals already using it keep their own copy and keep billing as they do now.`)) return
    try {
      await api.delete(`/companies/${company.id}/rental-boms/${bom.id}`)
      await loadCompany()
    } catch (e: any) {
      alert(e?.message || 'Failed to delete rental package')
    }
  }

  // Load operated pad/well counts
  useEffect(() => {
    if (!id) return
    Promise.all([
      api.get<{ total: number }>(`/locations/pads?operatorId=${id}&limit=0`),
      api.get<{ total: number }>(`/locations/wells?operatorId=${id}&limit=0`),
    ]).then(([padRes, wellRes]) => {
      setOpStats({ pads: padRes?.total || 0, wells: wellRes?.total || 0 })
    }).catch(() => {})
  }, [id])

  // Search source company for transfer
  useEffect(() => {
    if (!transferSourceSearch.trim()) { setTransferSourceResults([]); return }
    const t = setTimeout(async () => {
      try {
        const r = await api.get<{ data: Array<{ id: string; name: string }> }>(
          `/companies?search=${encodeURIComponent(transferSourceSearch.trim())}&limit=10&active=true`
        )
        setTransferSourceResults((r.data || []).filter(c => c.id !== id))
      } catch { setTransferSourceResults([]) }
    }, 200)
    return () => clearTimeout(t)
  }, [transferSourceSearch, id])

  async function handleTransfer() {
    if (!transferSource || !id) return
    if (!confirm(`Transfer ALL pads & wells from "${transferSource.name}" to "${company?.name}"?\n\nThis will update operator on all locations.`)) return
    setTransferring(true)
    try {
      const result = await api.post<{ ok: boolean; message: string; pads: number; wells: number }>(
        '/locations/transfer-operator',
        { fromOperatorId: transferSource.id, toOperatorId: id, notes: transferNotes || undefined }
      )
      alert(result.message)
      setTransferSource(null)
      setTransferSourceSearch('')
      setTransferNotes('')
      setTransferOpen(false)
      // Refresh stats
      Promise.all([
        api.get<{ total: number }>(`/locations/pads?operatorId=${id}&limit=0`),
        api.get<{ total: number }>(`/locations/wells?operatorId=${id}&limit=0`),
      ]).then(([p, w]) => setOpStats({ pads: p?.total || 0, wells: w?.total || 0 })).catch(() => {})
    } catch (err: any) {
      alert(err?.message || 'Transfer failed')
    }
    setTransferring(false)
  }

  // ---- Company Info Edit ----
  function startEditInfo() {
    if (!company) return
    setInfoDraft({
      name: company.name || '',
      legalName: company.legalName || '',
      companyType: company.companyType || 'operator',
      cashCcOnly: company.cashCcOnly ?? false,
      address: company.address || '',
      city: company.city || '',
      state: company.state || '',
      zip: company.zip || '',
      phone: company.phone || '',
      email: company.email || '',
      website: company.website || '',
      paymentTerms: company.paymentTerms || '',
      afeLabel: company.afeLabel || '',
      poLabel: company.poLabel || '',
      woLabel: company.woLabel || '',
      costCenterLabel: company.costCenterLabel || '',
    })
    setEditingInfo(true)
  }

  async function saveInfoEdit() {
    if (!company) return
    setInfoSaving(true)
    try {
      // Only send changed fields
      const updates: Record<string, any> = {}
      for (const [key, val] of Object.entries(infoDraft)) {
        const orig = (company as any)[key]
        const v = val === '' ? null : val
        if (v !== orig) updates[key] = v
      }
      // Name can't be null
      if (updates.name === null) delete updates.name
      if (Object.keys(updates).length > 0) {
        await api.put(`/companies/${company.id}`, updates)
      }
      setEditingInfo(false)
      await loadCompany()
    } catch (e: any) {
      setError('Save failed: ' + (e.message || 'Unknown'))
    } finally {
      setInfoSaving(false)
    }
  }

  // ---- Contact CRUD ----
  function startEditContact(c: Contact) {
    setEditingContactId(c.id)
    setContactDraft({
      name: c.name,
      title: c.title || '',
      phone: c.phone || '',
      email: c.email || '',
      role: c.role,
      isPrimary: c.isPrimary,
    })
    setAddingContact(false)
  }

  function startAddContact() {
    setAddingContact(true)
    setEditingContactId(null)
    setContactDraft({ ...emptyContact })
  }

  function cancelContactEdit() {
    setEditingContactId(null)
    setAddingContact(false)
    setContactDraft(emptyContact)
  }

  async function saveContact() {
    if (!company) return
    setContactSaving(true)
    try {
      const payload: Record<string, any> = {
        name: contactDraft.name,
        title: contactDraft.title || null,
        phone: contactDraft.phone || null,
        email: contactDraft.email || null,
        role: contactDraft.role,
        isPrimary: contactDraft.isPrimary,
      }
      if (addingContact) {
        await api.post(`/companies/${company.id}/contacts`, payload)
      } else if (editingContactId) {
        await api.put(`/companies/${company.id}/contacts/${editingContactId}`, payload)
      }
      cancelContactEdit()
      await loadCompany()
    } catch (e: any) {
      setError('Contact save failed: ' + (e.message || 'Unknown'))
    } finally {
      setContactSaving(false)
    }
  }

  async function deactivateContact(contactId: string) {
    if (!company) return
    try {
      await api.put(`/companies/${company.id}/contacts/${contactId}`, { isActive: false })
      await loadCompany()
    } catch (e: any) {
      setError('Failed to remove contact: ' + (e.message || 'Unknown'))
    }
  }

  // ---- Billing Profile CRUD ----
  function startAddProfile() {
    setAddingProfile(true)
    setEditingProfileId(null)
    setProfileDraft({ ...emptyProfileDraft })
  }

  function startEditProfile(bp: BillingProfile) {
    setEditingProfileId(bp.id)
    setAddingProfile(false)
    setProfileDraft({
      billingLevel: bp.billingLevel,
      isActive: bp.isActive,
      effectiveFrom: bp.effectiveFrom ? bp.effectiveFrom.slice(0, 10) : '',
      effectiveTo: bp.effectiveTo ? bp.effectiveTo.slice(0, 10) : '',
      enverusEnabled: bp.enverusEnabled,
      enverusReceiptMode: bp.enverusReceiptMode || 'none',
      enverusInvoiceMode: bp.enverusInvoiceMode || 'none',
      buyerDuns: bp.buyerDuns || '',
      buyerDunsPlus4: bp.buyerDunsPlus4 || '',
      buyerCode: bp.buyerCode || '',
      buyerSiteUuid: bp.buyerSiteUuid || '',
      supplierDuns: bp.supplierDuns || '016937650',
      supplierSiteDunsPlus4: bp.supplierSiteDunsPlus4 || '',
      stackedBillingEnabled: bp.stackedBillingEnabled,
      stackedBillingGroupBy: bp.stackedBillingGroupBy || '',
      stackedBillingPeriod: bp.stackedBillingPeriod || 'monthly',
      stackedBillingFiscalMonthStart: bp.stackedBillingFiscalMonthStart != null ? String(bp.stackedBillingFiscalMonthStart) : '',
      defaultOrderedByName: bp.defaultOrderedByName || '',
      defaultAfeNumber: bp.defaultAfeNumber || '',
      defaultCostCenter: bp.defaultCostCenter || '',
      afeNumberSource: bp.afeNumberSource || 'fixed',
      costCenterSource: bp.costCenterSource || 'fixed',
      buyerSiteSource: bp.buyerSiteSource || 'fixed',
      buyerDepartmentSource: bp.buyerDepartmentSource || 'fixed',
      defaultBuyerDepartment: bp.defaultBuyerDepartment || '',
      defaultPoNumber: bp.defaultPoNumber || '',
      defaultServiceApprover: (bp as any).defaultServiceApprover || '',
      defaultPriceBookNumber: (bp as any).defaultPriceBookNumber || '',
      defaultMajor: (bp as any).defaultMajor || '',
      defaultMinor: (bp as any).defaultMinor || '',
      labelAfe: ((bp as any).lineFieldLabels?.afeNumber) || '',
      labelCostCenter: ((bp as any).lineFieldLabels?.costCenter) || '',
      labelMajor: ((bp as any).lineFieldLabels?.major) || '',
      labelMinor: ((bp as any).lineFieldLabels?.minor) || '',
      facilityCodeAdfKey: (bp as any).facilityCodeAdfKey || '',
      defaultAdditionalDataFields: ((bp as any).defaultAdditionalDataFields || []).map((f: any) => {
        const { name, itemID, code, value, ...rest } = f
        return {
          name: name || '',
          itemID: itemID || '',
          code: code || '',
          value: value || '',
          _extra: Object.keys(rest).length ? rest : undefined,
        }
      }),
      requiresPo: bp.requiresPo,
      requiresAfe: bp.requiresAfe,
      requiresCostCenter: !!bp.requiresCostCenter,
      requiresBuyerSite: !!bp.requiresBuyerSite,
      requiresBuyerDepartment: !!bp.requiresBuyerDepartment,
      appliesToTicketTypes: bp.appliesToTicketTypes || [],
      appliesToDivisions: bp.appliesToDivisions || [],
      approvalRequired: bp.approvalRequired || 'never',
      approvalThresholdAmount: bp.approvalThresholdAmount || '',
      signatureRequired: (bp as any).signatureRequired || 'none',
      signatureApprovers: (bp as any).signatureApprovers || [],
      notes: bp.notes || '',
    })
    setExpandedProfile(bp.id)
  }

  function cancelProfileEdit() {
    setEditingProfileId(null)
    setAddingProfile(false)
    setProfileDraft(emptyProfileDraft)
  }

  async function saveProfile() {
    if (!company) return
    setProfileSaving(true)
    try {
      // Prisma expects ISO-8601 DateTime even for @db.Date columns
      const toIso = (d: string) => d ? new Date(d + 'T00:00:00Z').toISOString() : null
      const payload: Record<string, any> = {
        billingLevel: profileDraft.billingLevel,
        isActive: profileDraft.isActive,
        effectiveFrom: toIso(profileDraft.effectiveFrom),
        effectiveTo: toIso(profileDraft.effectiveTo),
        enverusEnabled: profileDraft.enverusEnabled,
        enverusReceiptMode: profileDraft.enverusReceiptMode,
        enverusInvoiceMode: profileDraft.enverusInvoiceMode,
        buyerDuns: profileDraft.buyerDuns || null,
        buyerDunsPlus4: profileDraft.buyerDunsPlus4 || null,
        buyerCode: profileDraft.buyerCode || null,
        buyerSiteUuid: profileDraft.buyerSiteUuid || null,
        supplierDuns: profileDraft.supplierDuns || null,
        supplierSiteDunsPlus4: profileDraft.supplierSiteDunsPlus4 || null,
        stackedBillingEnabled: profileDraft.stackedBillingEnabled,
        defaultOrderedByName: profileDraft.defaultOrderedByName || null,
        defaultAfeNumber: profileDraft.defaultAfeNumber || null,
        defaultCostCenter: profileDraft.defaultCostCenter || null,
        afeNumberSource: profileDraft.afeNumberSource,
        costCenterSource: profileDraft.costCenterSource,
        buyerSiteSource: profileDraft.buyerSiteSource,
        buyerDepartmentSource: profileDraft.buyerDepartmentSource,
        defaultBuyerDepartment: profileDraft.defaultBuyerDepartment.trim() || null,
        defaultPoNumber: profileDraft.defaultPoNumber || null,
        defaultServiceApprover: profileDraft.defaultServiceApprover || null,
        defaultPriceBookNumber: profileDraft.defaultPriceBookNumber || null,
        defaultMajor: profileDraft.defaultMajor || null,
        defaultMinor: profileDraft.defaultMinor || null,
        // Per-buyer relabeled line-field display labels. Only keep the set ones;
        // collapse an all-empty object to null.
        lineFieldLabels: (() => {
          const labels: Record<string, string> = {}
          if (profileDraft.labelAfe.trim()) labels.afeNumber = profileDraft.labelAfe.trim()
          if (profileDraft.labelCostCenter.trim()) labels.costCenter = profileDraft.labelCostCenter.trim()
          if (profileDraft.labelMajor.trim()) labels.major = profileDraft.labelMajor.trim()
          if (profileDraft.labelMinor.trim()) labels.minor = profileDraft.labelMinor.trim()
          return Object.keys(labels).length ? labels : null
        })(),
        facilityCodeAdfKey: profileDraft.facilityCodeAdfKey || null,
        // Buyer custom additional-data fields. Drop blank rows; keep only the
        // populated keys (value is always sent). Empty list → null.
        defaultAdditionalDataFields: (() => {
          const rows = profileDraft.defaultAdditionalDataFields
            .filter(f => f.name || f.itemID || f.code || f.value)
            .map(f => {
              const out: Record<string, any> = { ...(f._extra || {}), value: f.value }
              if (f.name) out.name = f.name
              if (f.itemID) out.itemID = f.itemID
              if (f.code) out.code = f.code
              return out
            })
          return rows.length ? rows : null
        })(),
        requiresPo: profileDraft.requiresPo,
        requiresAfe: profileDraft.requiresAfe,
        requiresCostCenter: profileDraft.requiresCostCenter,
        requiresBuyerSite: profileDraft.requiresBuyerSite,
        requiresBuyerDepartment: profileDraft.requiresBuyerDepartment,
        // #4 job-type scope — empty array → null (unscoped company-wide default).
        appliesToTicketTypes: profileDraft.appliesToTicketTypes.length ? profileDraft.appliesToTicketTypes : null,
        appliesToDivisions: profileDraft.appliesToDivisions.length ? profileDraft.appliesToDivisions : null,
        approvalRequired: profileDraft.approvalRequired,
        approvalThresholdAmount: profileDraft.approvalThresholdAmount ? parseFloat(profileDraft.approvalThresholdAmount) : null,
        signatureRequired: profileDraft.signatureRequired,
        signatureApprovers: profileDraft.signatureApprovers.length > 0 ? profileDraft.signatureApprovers : null,
        notes: profileDraft.notes || null,
      }
      // Only include stacked billing enum/int fields when they have values
      // (sending null for non-nullable Int or invalid enum values causes Prisma errors)
      if (profileDraft.stackedBillingGroupBy) payload.stackedBillingGroupBy = profileDraft.stackedBillingGroupBy
      if (profileDraft.stackedBillingPeriod) payload.stackedBillingPeriod = profileDraft.stackedBillingPeriod
      if (profileDraft.stackedBillingFiscalMonthStart) payload.stackedBillingFiscalMonthStart = parseInt(profileDraft.stackedBillingFiscalMonthStart)
      if (addingProfile) {
        await api.post(`/companies/${company.id}/billing-profiles`, payload)
      } else if (editingProfileId) {
        await api.put(`/companies/${company.id}/billing-profiles/${editingProfileId}`, payload)
      }
      cancelProfileEdit()
      await loadCompany()
    } catch (e: any) {
      setError('Profile save failed: ' + (e.message || 'Unknown'))
    } finally {
      setProfileSaving(false)
    }
  }

  async function deactivateProfile(profileId: string) {
    if (!company) return
    try {
      await api.put(`/companies/${company.id}/billing-profiles/${profileId}`, { isActive: false })
      await loadCompany()
    } catch (e: any) {
      setError('Failed to deactivate profile: ' + (e.message || 'Unknown'))
    }
  }

  // Activate / deactivate the customer. Inactive customers are hidden from the
  // ticket/rental/shop pickers and the server blocks new work for them;
  // existing tickets, invoices and history are untouched.
  async function toggleActive() {
    if (!company) return
    const next = !company.isActive
    if (!next && !window.confirm(
      `Deactivate ${company.name}?\n\nThey'll be hidden from the customer picker and no new work (tickets, rentals, shop orders) can be created for them. Existing records and history are unaffected. You can reactivate any time.`
    )) return
    setTogglingActive(true)
    try {
      await api.put(`/companies/${company.id}`, { isActive: next })
      await loadCompany()
    } catch (e: any) {
      setError('Failed to update status: ' + (e.message || 'Unknown'))
    } finally {
      setTogglingActive(false)
    }
  }

  // Put the customer on / take them off AR credit hold. Unlike deactivate this
  // leaves them fully visible and selectable — the block shows up as a red
  // banner at the two points that matter (new ticket, shop release) so staff
  // know to call AR instead of wondering where the customer went.
  async function toggleCreditHold() {
    if (!company) return
    const next = !company.creditHold
    const confirmText = next
      ? `Put ${company.name} on credit hold?

No new tickets can be created for them, and no equipment can be released back to them from a shop work order. Shop intake still works — gear can come in, it just can't leave. Existing tickets, rentals and invoices are unaffected.`
      : `Clear the credit hold on ${company.name}?

New tickets and shop equipment releases will be allowed again.`
    if (!window.confirm(confirmText)) return
    setTogglingCreditHold(true)
    try {
      await api.put(`/companies/${company.id}`, { creditHold: next })
      await loadCompany()
    } catch (e: any) {
      setError('Failed to update credit hold: ' + (e.message || 'Unknown'))
    } finally {
      setTogglingCreditHold(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
        <span className="ml-2 text-gray-500">Loading company...</span>
      </div>
    )
  }

  if (error && !company) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-6">
        <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      </div>
    )
  }

  if (!company) return null

  const co = company
  const fullAddress = [co.address, co.city, co.state, co.zip].filter(Boolean).join(', ')

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      {/* Error banner */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-500 hover:text-red-700"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Header */}
      <div>
        <button onClick={() => navigate('/companies')} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-3">
          <ArrowLeft className="w-4 h-4" /> All Customers
        </button>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center">
              <Building2 className="w-6 h-6 text-blue-600" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-900">{co.name}</h1>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full font-medium">
                  {TYPE_LABELS[co.companyType] || co.companyType}
                </span>
                {co.creditHold && (
                  <span className="text-xs bg-red-600 text-white px-2 py-0.5 rounded-full font-bold flex items-center gap-1">
                    <ShieldAlert className="w-3 h-3" /> CREDIT HOLD
                  </span>
                )}
                {!co.isActive && (
                  <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full font-medium">Inactive</span>
                )}
                {co.cashCcOnly && (
                  <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-medium flex items-center gap-1">
                    <CreditCard className="w-3 h-3" /> Cash / Card only
                  </span>
                )}
                {co.qbSyncStatus && (
                  <span className={cn(
                    'text-xs px-2 py-0.5 rounded-full font-medium',
                    co.qbCustomerListId && co.qbSyncStatus === 'synced' ? 'bg-green-100 text-green-700' :
                    co.qbSyncStatus === 'pending' ? 'bg-yellow-100 text-yellow-700' :
                    'bg-gray-100 text-gray-600'
                  )}>
                    QB: {co.qbCustomerListId ? co.qbSyncStatus : 'mapping missing'}
                  </span>
                )}
              </div>
            </div>
          </div>
          {canEdit && !editingInfo && (
            <div className="flex items-center gap-3 mt-1">
              <button
                onClick={toggleActive}
                disabled={togglingActive}
                className={cn(
                  'text-sm flex items-center gap-1 disabled:opacity-50',
                  co.isActive ? 'text-red-600 hover:text-red-800' : 'text-green-600 hover:text-green-800',
                )}
              >
                {togglingActive
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : (co.isActive ? <Ban className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5" />)}
                {co.isActive ? 'Deactivate' : 'Reactivate'}
              </button>
              <button
                onClick={toggleCreditHold}
                disabled={togglingCreditHold}
                title="Blocks new tickets and shop equipment returns for this customer"
                className={cn(
                  'text-sm flex items-center gap-1 disabled:opacity-50',
                  co.creditHold ? 'text-green-600 hover:text-green-800' : 'text-red-600 hover:text-red-800',
                )}
              >
                {togglingCreditHold
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : (co.creditHold ? <CheckCircle2 className="w-3.5 h-3.5" /> : <ShieldAlert className="w-3.5 h-3.5" />)}
                {co.creditHold ? 'Clear Credit Hold' : 'Credit Hold'}
              </button>
              <button onClick={startEditInfo} className="text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1">
                <Pencil className="w-3.5 h-3.5" /> Edit
              </button>
            </div>
          )}
        </div>
        {co.legalName && co.legalName !== co.name && !editingInfo && (
          <p className="text-sm text-gray-500 mt-1 ml-15">Legal: {co.legalName}</p>
        )}
        {co.parentCompany && (
          <button
            onClick={() => navigate(`/companies/${co.parentCompany!.id}`)}
            className="text-sm text-blue-600 hover:underline mt-1 flex items-center gap-1"
          >
            <ExternalLink className="w-3 h-3" /> Parent: {co.parentCompany.name}
          </button>
        )}
      </div>

      {/* Company Info Card — View or Edit */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <Building2 className="w-4 h-4" /> Company Info
          </h2>
          {editingInfo && (
            <div className="flex items-center gap-2">
              <button onClick={() => setEditingInfo(false)} className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1">
                <X className="w-3.5 h-3.5" /> Cancel
              </button>
              <button onClick={saveInfoEdit} disabled={infoSaving} className="text-xs text-white bg-blue-600 hover:bg-blue-700 px-3 py-1 rounded flex items-center gap-1 disabled:opacity-50">
                {infoSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save
              </button>
            </div>
          )}
        </div>
        <div className="px-4 py-3">
          {editingInfo ? (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <EditField label="Name" value={infoDraft.name} onChange={v => setInfoDraft(d => ({ ...d, name: v }))} required />
                <EditField label="Legal Name" value={infoDraft.legalName} onChange={v => setInfoDraft(d => ({ ...d, legalName: v }))} />
                <div>
                  <label className="text-xs font-medium text-gray-500 block mb-1">Type</label>
                  <select
                    value={infoDraft.companyType}
                    onChange={e => setInfoDraft(d => ({ ...d, companyType: e.target.value }))}
                    className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                  >
                    {COMPANY_TYPES.map(t => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-500 block mb-1">Payment Type</label>
                  <select
                    value={infoDraft.cashCcOnly ? 'cash_cc' : 'account'}
                    onChange={e => setInfoDraft(d => ({ ...d, cashCcOnly: e.target.value === 'cash_cc' }))}
                    className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="account">On account</option>
                    <option value="cash_cc">Cash / Card only</option>
                  </select>
                </div>
              </div>
              <hr className="border-gray-100" />
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <EditField label="Address" value={infoDraft.address} onChange={v => setInfoDraft(d => ({ ...d, address: v }))} />
                </div>
                <EditField label="City" value={infoDraft.city} onChange={v => setInfoDraft(d => ({ ...d, city: v }))} />
                <div className="grid grid-cols-2 gap-3">
                  <EditField label="State" value={infoDraft.state} onChange={v => setInfoDraft(d => ({ ...d, state: v }))} />
                  <EditField label="Zip" value={infoDraft.zip} onChange={v => setInfoDraft(d => ({ ...d, zip: v }))} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <EditField label="Phone" value={infoDraft.phone} onChange={v => setInfoDraft(d => ({ ...d, phone: v }))} />
                <EditField label="Email" value={infoDraft.email} onChange={v => setInfoDraft(d => ({ ...d, email: v }))} />
                <EditField label="Website" value={infoDraft.website} onChange={v => setInfoDraft(d => ({ ...d, website: v }))} />
                <EditField label="Payment Terms" value={infoDraft.paymentTerms} onChange={v => setInfoDraft(d => ({ ...d, paymentTerms: v }))} />
              </div>
              <hr className="border-gray-100" />
              <p className="text-xs font-medium text-gray-500">Custom Field Labels</p>
              <div className="grid grid-cols-2 gap-3">
                <EditField label="AFE Label" value={infoDraft.afeLabel} onChange={v => setInfoDraft(d => ({ ...d, afeLabel: v }))} placeholder="e.g. AFE#" />
                <EditField label="PO Label" value={infoDraft.poLabel} onChange={v => setInfoDraft(d => ({ ...d, poLabel: v }))} placeholder="e.g. PO#" />
                <EditField label="WO Label" value={infoDraft.woLabel} onChange={v => setInfoDraft(d => ({ ...d, woLabel: v }))} placeholder="e.g. Work Order" />
                <EditField label="Cost Center" value={infoDraft.costCenterLabel} onChange={v => setInfoDraft(d => ({ ...d, costCenterLabel: v }))} placeholder="e.g. Cost Center" />
              </div>
            </div>
          ) : (
            <div className="space-y-2 text-sm">
              {fullAddress && (
                <div className="flex items-start gap-2">
                  <MapPin className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
                  <span className="text-gray-700">{fullAddress}</span>
                </div>
              )}
              {co.phone && (
                <div className="flex items-center gap-2">
                  <Phone className="w-4 h-4 text-gray-400 flex-shrink-0" />
                  <a href={`tel:${co.phone}`} className="text-blue-600 hover:underline">{co.phone}</a>
                </div>
              )}
              {co.email && (
                <div className="flex items-center gap-2">
                  <Mail className="w-4 h-4 text-gray-400 flex-shrink-0" />
                  <a href={`mailto:${co.email}`} className="text-blue-600 hover:underline">{co.email}</a>
                </div>
              )}
              {co.website && (
                <div className="flex items-center gap-2">
                  <Globe className="w-4 h-4 text-gray-400 flex-shrink-0" />
                  <a href={co.website.startsWith('http') ? co.website : `https://${co.website}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{co.website}</a>
                </div>
              )}
              {!fullAddress && !co.phone && !co.email && !co.website && (
                <p className="text-gray-400 italic">No contact info on file.</p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Billing Configuration Card */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="px-4 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <CreditCard className="w-4 h-4" /> Billing Configuration
          </h2>
        </div>
        <div className="px-4 py-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <InfoRow label="Payment Type" value={co.cashCcOnly ? 'Cash / Card only' : 'On account'} />
            <InfoRow label="Payment Terms" value={co.paymentTerms || '---'} />
            <InfoRow label="Due Date Offset" value={co.dueDateOffset != null ? `${co.dueDateOffset} days` : '---'} />
            <InfoRow label="Price Book" value={co.priceBookNumber || '---'} />
            <InfoRow label="Attach Field Ticket" value={co.attachFieldTicket ? 'Yes' : 'No'} />
            <InfoRow label="Attach Invoice" value={co.attachInvoice ? 'Yes' : 'No'} />
          </div>

          {/* Wave 5 5C — Price Level assignment. Drives invoice-time pricing
              adjustments via services/billingRules.ts. */}
          <div className="mt-3 pt-3 border-t border-gray-100">
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-xs font-medium text-gray-500">QB Price Level</p>
              {co.assignedPriceLevel && (
                <span className="text-[10px] text-gray-400">
                  {co.assignedPriceLevel._count?.items ?? 0} per-item rule{(co.assignedPriceLevel._count?.items ?? 0) === 1 ? '' : 's'}
                </span>
              )}
            </div>
            {canEdit ? (
              <div className="flex items-center gap-2">
                <select
                  value={co.qbPriceLevelId || ''}
                  onChange={e => handleSetPriceLevel(e.target.value || null)}
                  disabled={savingPriceLevel}
                  className="flex-1 text-sm border border-gray-300 rounded px-2 py-1.5 bg-white disabled:opacity-50"
                >
                  <option value="">— None —</option>
                  {priceLevelOptions.map(pl => (
                    <option key={pl.id} value={pl.id}>
                      {pl.name}{pl.itemCount ? ` (${pl.itemCount} items)` : ''}
                    </option>
                  ))}
                </select>
                {savingPriceLevel && <Loader2 className="w-4 h-4 animate-spin text-gray-400" />}
              </div>
            ) : (
              <p className="text-sm text-gray-700">{co.assignedPriceLevel?.name || '---'}</p>
            )}
            {co.qbPriceLevel && !co.assignedPriceLevel && (
              <p className="text-[11px] text-amber-700 mt-1">
                Legacy free-text value: <span className="font-mono">{co.qbPriceLevel}</span>. Pick a synced level above to drive invoice pricing.
              </p>
            )}
          </div>

          <CustomerDescriptions key={co.id} companyId={co.id} canEdit={canEditBilling} />

          {/* ND sales-tax exemption — defaults this customer's invoice lines
              non-taxable (resale / direct-pay / government cert on file). */}
          <div className="mt-3 pt-3 border-t border-gray-100">
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-xs font-medium text-gray-500">Sales Tax Exempt</p>
              {savingTaxExempt && <Loader2 className="w-4 h-4 animate-spin text-gray-400" />}
            </div>
            {canEdit ? (
              <>
                <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={co.taxExempt}
                    onChange={e => handleSetTaxExempt({ taxExempt: e.target.checked })}
                    disabled={savingTaxExempt}
                    className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  Exempt from ND sales tax
                </label>
                {co.taxExempt && (
                  <input
                    type="text"
                    defaultValue={co.taxExemptCertNumber || ''}
                    onBlur={e => {
                      const v = e.target.value.trim() || null
                      if (v !== (co.taxExemptCertNumber || null)) handleSetTaxExempt({ taxExemptCertNumber: v })
                    }}
                    placeholder="Exemption / direct-pay certificate #"
                    disabled={savingTaxExempt}
                    className="mt-2 w-full text-sm border border-gray-300 rounded px-2 py-1.5 bg-white disabled:opacity-50"
                  />
                )}
              </>
            ) : (
              <p className="text-sm text-gray-700">
                {co.taxExempt ? `Exempt${co.taxExemptCertNumber ? ` — cert ${co.taxExemptCertNumber}` : ''}` : 'No'}
              </p>
            )}
          </div>

          {(co.afeLabel || co.poLabel || co.woLabel || co.costCenterLabel) && (
            <div className="mt-3 pt-3 border-t border-gray-100">
              <p className="text-xs font-medium text-gray-500 mb-1.5">Custom Field Labels</p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                {co.afeLabel && <InfoRow label="AFE Label" value={co.afeLabel} />}
                {co.poLabel && <InfoRow label="PO Label" value={co.poLabel} />}
                {co.woLabel && <InfoRow label="WO Label" value={co.woLabel} />}
                {co.costCenterLabel && <InfoRow label="Cost Center Label" value={co.costCenterLabel} />}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Rental Packages Card — per-customer BOM: the baseline gear the flat
          rig-up + daily rate covers. Editing uses its own rental-package permission. */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="px-4 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <Package className="w-4 h-4" /> Rental Packages
            <span className="text-xs text-gray-400 font-normal">Baseline gear the flat rate covers</span>
          </h2>
        </div>
        <div className="divide-y divide-gray-100">
          {(['manned', 'unmanned', 'other', 'rig'] as const).map(type => {
            // Several variants of one type are normal — the MSA prices "with
            // monitors" and "without" separately, so each is its own package
            // bound to its own QB item. Dispatch preselects the default.
            const boms = (co.rentalBoms || []).filter(b => b.bomType === type)
            const editor = (key: string) => (
              <BomEditor
                key={key}
                draft={editingBom!}
                products={bomProducts}
                onChange={setEditingBom}
                onSave={saveBom}
                onCancel={() => setEditingBom(null)}
                saving={bomSaving}
                variantCount={boms.length}
              />
            )
            const addingHere = canEditRentalPackages && editingBom && !editingBom.id && editingBom.bomType === type
            return (
              <div key={type} className="px-4 py-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-900">
                    {BOM_TYPE_LABELS[type]}
                    {boms.length > 1 && <span className="ml-1.5 text-xs font-normal text-gray-400">{boms.length} variants</span>}
                  </span>
                  {canEditRentalPackages && !editingBom && (
                    <button onClick={() => startAddBom(type)} className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1">
                      <Plus className="w-3.5 h-3.5" /> {boms.length ? 'Add variant' : 'Add'}
                    </button>
                  )}
                </div>
                {boms.map(bom => canEditRentalPackages && editingBom?.id === bom.id ? editor(bom.id) : (
                  <div key={bom.id} className={boms.length > 1 ? 'border border-gray-100 rounded-md px-3 py-2' : ''}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {(bom.name || boms.length > 1) && (
                          <span className="text-sm text-gray-800 truncate">{bom.name || bom.packageProduct?.name || 'Unnamed variant'}</span>
                        )}
                        {boms.length > 1 && bom.isDefault && (
                          <span className="text-[10px] uppercase tracking-wide bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded">Default</span>
                        )}
                        <span className="text-xs text-gray-400 whitespace-nowrap">
                          {bom.manned ? `Manned · ${bom.includedTechs} tech${bom.includedTechs === 1 ? '' : 's'} incl.` : 'Unmanned'}
                        </span>
                      </div>
                      {canEditRentalPackages && !editingBom && (
                        <div className="flex items-center gap-1 shrink-0">
                          <button onClick={() => startEditBom(bom)} aria-label="Edit package" className="p-1.5 text-gray-400 hover:text-blue-600 rounded">
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => deleteBom(bom)} aria-label="Delete package" className="p-1.5 text-gray-400 hover:text-red-600 rounded">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                    {bom.items.length ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {bom.items.map(i => (
                          <span key={i.id} className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full">
                            {i.qty}× {EQUIP_CAT_LABEL[i.equipmentCategory] || i.equipmentCategory}{i.label ? ` (${i.label})` : ''}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-1 text-xs text-gray-400 italic">No items — baseline is empty.</p>
                    )}
                    {bom.packageProduct ? (
                      <p className="mt-1.5 text-xs text-gray-500">
                        Bills as <span className="font-medium text-gray-700">{bom.packageProduct.name}</span>
                        {bom.packageProduct.partNumber ? <span className="text-gray-400"> · {bom.packageProduct.partNumber}</span> : null}
                        {bom.packageRate != null
                          ? <span className="text-gray-400"> · ${Number(bom.packageRate)} ({bom.packagePriceLevel || 'price level'})</span>
                          : <span className="text-amber-600"> · list price — not on this customer&rsquo;s QB price level</span>}
                      </p>
                    ) : (
                      <p className="mt-1.5 text-xs text-amber-600">No billing item — this package won&rsquo;t bill.</p>
                    )}
                    {bom.notes && <p className="mt-1 text-xs text-gray-500">{bom.notes}</p>}
                  </div>
                ))}
                {addingHere && editor('new')}
                {!boms.length && !addingHere && (
                  <p className="text-xs text-gray-400 italic">
                    No {BOM_TYPE_LABELS[type].toLowerCase()} package{type === 'rig' ? ' — rig jobs fall back to legacy drilling/none.' : '.'}
                  </p>
                )}
              </div>
            )
          })}
          {co.rentalBoms?.some(b => b.bomType === 'standard' || b.bomType === 'drilling') && (
            <div className="px-4 py-3 bg-amber-50 text-xs text-amber-800">
              Legacy packages still exist for this customer and will be used as fallbacks until replaced:
              {' '}
              {co.rentalBoms
                .filter(b => b.bomType === 'standard' || b.bomType === 'drilling')
                .map(b => BOM_TYPE_LABELS[b.bomType])
                .join(', ')}
            </div>
          )}
        </div>
      </div>

      {/* Contacts Card */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <Users className="w-4 h-4" /> Contacts
            <span className="text-xs text-gray-400 font-normal">({co.contacts.length})</span>
          </h2>
          {canEdit && !addingContact && !editingContactId && (
            <button onClick={startAddContact} className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1">
              <Plus className="w-3.5 h-3.5" /> Add
            </button>
          )}
        </div>
        <div className="divide-y divide-gray-100">
          {/* Add new contact form */}
          {addingContact && (
            <ContactForm
              draft={contactDraft}
              onChange={setContactDraft}
              onSave={saveContact}
              onCancel={cancelContactEdit}
              saving={contactSaving}
            />
          )}

          {co.contacts.length === 0 && !addingContact ? (
            <p className="px-4 py-6 text-sm text-gray-400 text-center italic">No contacts on file.</p>
          ) : (
            co.contacts.map(c => {
              if (editingContactId === c.id) {
                return (
                  <ContactForm
                    key={c.id}
                    draft={contactDraft}
                    onChange={setContactDraft}
                    onSave={saveContact}
                    onCancel={cancelContactEdit}
                    saving={contactSaving}
                  />
                )
              }
              return (
                <div key={c.id} className="px-4 py-3 flex items-center gap-3 group">
                  <div className="w-8 h-8 rounded-full bg-blue-50 flex items-center justify-center text-xs font-bold text-blue-600 flex-shrink-0">
                    {c.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900">{c.name}</span>
                      {c.isPrimary && (
                        <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">Primary</span>
                      )}
                      <span className="text-xs text-gray-400">{ROLE_LABELS[c.role] || c.role}</span>
                    </div>
                    {c.title && <p className="text-xs text-gray-500">{c.title}</p>}
                    <div className="flex items-center gap-3 mt-0.5">
                      {c.phone && (
                        <a href={`tel:${c.phone}`} className="text-xs text-blue-600 hover:underline flex items-center gap-1">
                          <Phone className="w-3 h-3" />{c.phone}
                        </a>
                      )}
                      {c.email && (
                        <a href={`mailto:${c.email}`} className="text-xs text-blue-600 hover:underline flex items-center gap-1">
                          <Mail className="w-3 h-3" />{c.email}
                        </a>
                      )}
                    </div>
                  </div>
                  {canEdit && (
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                      <button onClick={() => startEditContact(c)} className="p-1.5 text-gray-400 hover:text-blue-600 rounded">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => deactivateContact(c.id)} className="p-1.5 text-gray-400 hover:text-red-600 rounded">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* Operations Card — pad/well counts + operator transfer */}
      {co.companyType === 'operator' && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
              <MapPin className="w-4 h-4" /> Operations
              {opStats && (
                <span className="text-xs text-gray-400 font-normal">
                  {opStats.pads} pad{opStats.pads !== 1 ? 's' : ''} · {opStats.wells} well{opStats.wells !== 1 ? 's' : ''}
                </span>
              )}
            </h2>
            {canEdit && (
              <button
                onClick={() => setTransferOpen(!transferOpen)}
                className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
              >
                {transferOpen ? <X className="w-3.5 h-3.5" /> : <ArrowLeft className="w-3.5 h-3.5 rotate-180" />}
                {transferOpen ? 'Cancel' : 'Transfer In'}
              </button>
            )}
          </div>

          {opStats && opStats.pads === 0 && !transferOpen && (
            <div className="px-4 py-3 text-sm text-gray-400">
              No operated locations. Use "Transfer In" to acquire pads from another operator.
            </div>
          )}

          {transferOpen && (
            <div className="px-4 py-3 space-y-3">
              <p className="text-xs text-gray-500">
                Transfer all pads &amp; wells from another operator to <strong>{co.name}</strong>.
              </p>

              {/* Source company search */}
              <div>
                <label className="text-xs font-medium text-gray-500 block mb-1">Source Operator</label>
                {transferSource ? (
                  <div className="flex items-center gap-2 p-2 bg-blue-50 border border-blue-200 rounded text-sm">
                    <Building2 className="w-4 h-4 text-blue-600 shrink-0" />
                    <span className="flex-1 font-medium">{transferSource.name}</span>
                    <button onClick={() => { setTransferSource(null); setTransferSourceSearch('') }} className="text-xs text-blue-600 hover:text-blue-800">Change</button>
                  </div>
                ) : (
                  <div className="relative">
                    <input
                      type="text"
                      value={transferSourceSearch}
                      onChange={e => setTransferSourceSearch(e.target.value)}
                      placeholder="Search operator to transfer from..."
                      className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                    />
                    {transferSourceResults.length > 0 && (
                      <div className="absolute z-20 left-0 right-0 mt-1 bg-white border border-gray-200 rounded shadow-lg max-h-48 overflow-y-auto">
                        {transferSourceResults.map(c => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => { setTransferSource(c); setTransferSourceSearch(''); setTransferSourceResults([]) }}
                            className="w-full text-left px-3 py-2 hover:bg-gray-50 text-sm transition-colors"
                          >
                            {c.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div>
                <label className="text-xs font-medium text-gray-500 block mb-1">Notes (optional)</label>
                <input
                  type="text"
                  value={transferNotes}
                  onChange={e => setTransferNotes(e.target.value)}
                  placeholder="e.g. Devon acquisition Q1 2026"
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>

              <button
                onClick={handleTransfer}
                disabled={!transferSource || transferring}
                className="text-xs text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 px-4 py-2 rounded flex items-center gap-1.5"
              >
                {transferring ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowLeft className="w-3.5 h-3.5 rotate-180" />}
                Transfer All Locations to {co.name}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Billing Profiles Card */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <Receipt className="w-4 h-4" /> Billing Profiles
            <span className="text-xs text-gray-400 font-normal">({co.billingProfiles.length})</span>
          </h2>
          {canEditBilling && !addingProfile && !editingProfileId && (
            <button onClick={startAddProfile} className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1">
              <Plus className="w-3.5 h-3.5" /> Add
            </button>
          )}
        </div>
        <p className="px-4 pb-3 text-xs text-slate-500">Profiles match the service date, ticket type and division. More specific scopes win; matching scopes use the most recent effective start date.</p>
        <div className="divide-y divide-gray-100">
          {/* Add new profile form */}
          {addingProfile && (
            <BillingProfileForm
              draft={profileDraft}
              onChange={setProfileDraft}
              onSave={saveProfile}
              onCancel={cancelProfileEdit}
              saving={profileSaving}
            />
          )}

          {co.billingProfiles.length === 0 && !addingProfile ? (
            <p className="px-4 py-6 text-sm text-gray-400 text-center italic">No billing profiles configured.</p>
          ) : (
            co.billingProfiles.map(bp => {
              const isExpanded = expandedProfile === bp.id

              // If editing this profile, show the form instead
              if (editingProfileId === bp.id) {
                return (
                  <BillingProfileForm
                    key={bp.id}
                    draft={profileDraft}
                    onChange={setProfileDraft}
                    onSave={saveProfile}
                    onCancel={cancelProfileEdit}
                    saving={profileSaving}
                  />
                )
              }

              return (
                <div key={bp.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setExpandedProfile(isExpanded ? null : bp.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedProfile(isExpanded ? null : bp.id) } }}
                    className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors group cursor-pointer"
                  >
                    <div>
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-medium text-gray-800 capitalize">{bp.billingLevel} Level</span>
                        {bp.enverusEnabled && <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">Enverus</span>}
                        {bp.stackedBillingEnabled && <span className="text-xs bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded">Stacked</span>}
                        {bp.requiresPo && <span className="text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded">PO Req</span>}
                        {bp.requiresAfe && <span className="text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded">AFE Req</span>}
                        {bp.requiresCostCenter && <span className="text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded">CC Req</span>}
                        {bp.requiresBuyerSite && <span className="text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded">Subcompany Req</span>}
                        {bp.requiresBuyerDepartment && <span className="text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded">Dept Req</span>}
                        {!bp.isActive && <span className="text-xs bg-red-100 text-red-600 px-1.5 py-0.5 rounded">Inactive</span>}
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">
                        Effective: {formatCalendarDate(bp.effectiveFrom)}{bp.effectiveTo ? ` — ${formatCalendarDate(bp.effectiveTo)}` : ' — present'}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      {canEditBilling && (
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity mr-1">
                          <button
                            onClick={(e) => { e.stopPropagation(); startEditProfile(bp) }}
                            className="p-1.5 text-gray-400 hover:text-blue-600 rounded"
                            title="Edit profile"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          {bp.isActive && (
                            <button
                              onClick={(e) => { e.stopPropagation(); deactivateProfile(bp.id) }}
                              className="p-1.5 text-gray-400 hover:text-red-600 rounded"
                              title="Deactivate profile"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      )}
                      {isExpanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="px-4 pb-3 pt-0 space-y-2">
                      <div className="bg-gray-50 rounded-lg p-3 text-sm grid grid-cols-2 gap-x-6 gap-y-1.5">
                        <InfoRow label="Billing Level" value={bp.billingLevel} />
                        <InfoRow label="Approval" value={bp.approvalRequired === 'never' ? 'None' : bp.approvalRequired} />
                        {bp.approvalThresholdAmount && <InfoRow label="Approval Threshold" value={`$${parseFloat(bp.approvalThresholdAmount).toFixed(2)}`} />}
                        {bp.defaultOrderedByName && <InfoRow label="Default Requisitioner" value={bp.defaultOrderedByName} />}
                        {(bp as any).defaultServiceApprover && <InfoRow label="Default Service Approver" value={(bp as any).defaultServiceApprover} />}
                        {bp.defaultPoNumber && <InfoRow label="Default PO" value={bp.defaultPoNumber} />}
                        {(bp.defaultAfeNumber || bp.afeNumberSource === 'location') && <InfoRow label={(bp as any).lineFieldLabels?.afeNumber || 'Default AFE'} value={fieldSourceText(bp.afeNumberSource, bp.defaultAfeNumber, 'facility code')} />}
                        {(bp.defaultCostCenter || bp.costCenterSource === 'location') && <InfoRow label={(bp as any).lineFieldLabels?.costCenter || 'Default Cost Center'} value={fieldSourceText(bp.costCenterSource, bp.defaultCostCenter, 'cost code')} />}
                        {bp.buyerSiteSource === 'location' && <InfoRow label="Subcompany" value="Well/pad subcompany, else the buyer site above" />}
                        {(bp.defaultBuyerDepartment || bp.buyerDepartmentSource === 'location') && <InfoRow label="Department" value={fieldSourceText(bp.buyerDepartmentSource, bp.defaultBuyerDepartment, 'department')} />}
                        {(bp as any).defaultMajor && <InfoRow label={(bp as any).lineFieldLabels?.major || 'Activity Code (major)'} value={(bp as any).defaultMajor} />}
                        {(bp as any).defaultMinor && <InfoRow label={(bp as any).lineFieldLabels?.minor || 'Functional Area (minor)'} value={(bp as any).defaultMinor} />}
                        {(bp as any).defaultPriceBookNumber && <InfoRow label="Default Price Book" value={(bp as any).defaultPriceBookNumber} />}
                        {(bp as any).facilityCodeAdfKey && <InfoRow label="Facility Property field" value={(bp as any).facilityCodeAdfKey} />}
                        {(bp as any).defaultAdditionalDataFields?.length > 0 && (
                          <InfoRow
                            label="Custom data fields"
                            value={(bp as any).defaultAdditionalDataFields
                              .map((f: any) => `${f.name || f.itemID || '?'}${f.value ? `: ${f.value}` : ''}`)
                              .join(', ')}
                          />
                        )}
                        {(bp as any).signatureRequired && (bp as any).signatureRequired !== 'none' && (
                          <InfoRow label="Signature Required" value={(bp as any).signatureRequired === 'both' ? 'Ticket & Invoice' : (bp as any).signatureRequired === 'ticket' ? 'Ticket' : 'Invoice'} />
                        )}
                        {(bp as any).signatureApprovers?.length > 0 && (
                          <InfoRow label="Approvers" value={(bp as any).signatureApprovers.map((a: any) => a.name).join(', ')} />
                        )}
                        {bp.enverusEnabled && (
                          <>
                            <InfoRow label="Receipt Mode" value={RECEIPT_MODES.find(r => r.value === bp.enverusReceiptMode)?.label || bp.enverusReceiptMode} />
                            <InfoRow label="Invoice Mode" value={INVOICE_MODES.find(r => r.value === bp.enverusInvoiceMode)?.label || bp.enverusInvoiceMode} />
                            {bp.buyerDuns && <InfoRow label="Buyer DUNS" value={bp.buyerDuns} />}
                            {bp.buyerDunsPlus4 && <InfoRow label="Buyer DUNS+4" value={bp.buyerDunsPlus4} />}
                            {bp.buyerCode && <InfoRow label="Buyer Code" value={bp.buyerCode} />}
                            {bp.supplierDuns && <InfoRow label="Supplier DUNS" value={bp.supplierDuns} />}
                          </>
                        )}
                        {bp.stackedBillingEnabled && (
                          <>
                            <InfoRow label="Stacked Group By" value={bp.stackedBillingGroupBy || '---'} />
                            <InfoRow label="Stacked Period" value={STACKED_PERIODS.find(s => s.value === bp.stackedBillingPeriod)?.label || bp.stackedBillingPeriod || '---'} />
                            {bp.stackedBillingFiscalMonthStart && <InfoRow label="Fiscal Month Start" value={String(bp.stackedBillingFiscalMonthStart)} />}
                          </>
                        )}
                      </div>
                      {bp.notes && <p className="text-xs text-gray-500 italic">{bp.notes}</p>}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* Operator Aliases */}
      {co.operatorAliases.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
          <div className="px-4 py-3 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
              <Tag className="w-4 h-4" /> Operator Aliases
              <span className="text-xs text-gray-400 font-normal">({co.operatorAliases.length})</span>
            </h2>
          </div>
          <div className="px-4 py-3">
            <div className="flex flex-wrap gap-2">
              {co.operatorAliases.map(a => (
                <span key={a.id} className="text-xs bg-gray-100 text-gray-700 px-2.5 py-1 rounded-full">
                  {a.aliasName}
                  {a.source && <span className="text-gray-400 ml-1">({a.source})</span>}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Child Companies */}
      {co.childCompanies.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
          <div className="px-4 py-3 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
              <Building2 className="w-4 h-4" /> Child Companies
              <span className="text-xs text-gray-400 font-normal">({co.childCompanies.length})</span>
            </h2>
          </div>
          <div className="divide-y divide-gray-100">
            {co.childCompanies.map(child => {
              const padCount = child.padCount ?? 0
              const wellCount = child.wellCount ?? 0
              const fields = child.assignedFieldNames ?? []
              const fieldsToShow = fields.slice(0, 4)
              const fieldsRemaining = Math.max(0, fields.length - fieldsToShow.length)
              return (
                <button
                  key={child.id}
                  onClick={() => navigate(`/companies/${child.id}`)}
                  className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="text-sm font-medium text-gray-800">{child.name}</span>
                      <span className="ml-2 text-xs text-gray-400">{TYPE_LABELS[child.companyType] || child.companyType}</span>
                    </div>
                    {!child.isActive && <span className="text-xs text-red-500 shrink-0">Inactive</span>}
                  </div>
                  {(padCount > 0 || wellCount > 0) && (
                    <div className="text-xs text-gray-500 mt-0.5">
                      {padCount} pad{padCount === 1 ? '' : 's'} · {wellCount} well{wellCount === 1 ? '' : 's'}
                    </div>
                  )}
                  {fieldsToShow.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {fieldsToShow.map(fn => (
                        <span key={fn} className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600">
                          {fn}
                        </span>
                      ))}
                      {fieldsRemaining > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">
                          +{fieldsRemaining}
                        </span>
                      )}
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* QuickBooks Info */}
      {co.qbCustomerListId && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
          <div className="px-4 py-3 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
              <FileText className="w-4 h-4" /> QuickBooks
            </h2>
          </div>
          <div className="px-4 py-3 text-sm grid grid-cols-2 gap-x-6 gap-y-1.5">
            <InfoRow label="QB List ID" value={co.qbCustomerListId} />
            {co.qbCustomerFullName && <InfoRow label="QB Full Name" value={co.qbCustomerFullName} />}
            {co.qbPriceLevel && <InfoRow label="QB Price Level" value={co.qbPriceLevel} />}
            {co.qbSyncStatus && <InfoRow label="Sync Status" value={co.qbSyncStatus} />}
          </div>
        </div>
      )}

      {/* Footer metadata */}
      <div className="text-xs text-gray-400 text-center pb-4">
        Created {formatDate(co.createdAt)} &middot; Last updated {formatDate(co.updatedAt)}
      </div>
    </div>
  )
}

// ---- Subcomponents ----

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-gray-500 flex-shrink-0">{label}:</span>
      <span className="text-gray-800 font-medium truncate">{value}</span>
    </div>
  )
}

function fieldSourceText(source: BillingFieldSource, fallback: string | null, codeLabel: string) {
  if (source !== 'location') return fallback || ''
  return `Well/pad ${codeLabel}${fallback ? `, else ${fallback}` : ''}`
}

function FieldSourceSelect({ value, codeLabel, onChange, defaultLabel = 'the default above' }: {
  value: BillingFieldSource; codeLabel: string; onChange: (v: BillingFieldSource) => void; defaultLabel?: string
}) {
  return (
    <label className="flex items-center gap-2 mt-1 text-xs text-gray-500">
      Value
      <select value={value} onChange={e => onChange(e.target.value as BillingFieldSource)}
        className="border border-gray-300 rounded px-1.5 py-0.5 text-xs text-gray-700">
        <option value="fixed">Always {defaultLabel}</option>
        <option value="location">From the ticket's well/pad {codeLabel} ({defaultLabel} as fallback)</option>
      </select>
    </label>
  )
}

function EditField({ label, value, onChange, placeholder, required }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; required?: boolean
}) {
  return (
    <div>
      <label className="text-xs font-medium text-gray-500 block mb-1">{label}{required && ' *'}</label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
      />
    </div>
  )
}

/** "PN-123 — Area Monitor", the label AR picks by. */
const productLabel = (p: RentalBomProduct) => `${p.partNumber ? `${p.partNumber} — ` : ''}${p.name}`

/**
 * Type-ahead product binding over the full catalog (~1k items), via a native
 * datalist — no dropdown of a thousand options, and it degrades to a plain
 * text field. Clearing the text unbinds, which is a legitimate choice: an
 * unbound package simply doesn't bill.
 */
function ProductBindInput({ value, products, listId, placeholder, onChange }: {
  value: string
  products: RentalBomProduct[]
  listId: string
  placeholder: string
  onChange: (id: string) => void
}) {
  const selected = products.find(p => p.id === value)
  const [text, setText] = useState(selected ? productLabel(selected) : '')

  // Re-sync when the bound product changes from outside (row reordering, or the
  // catalog arriving after the editor opened).
  useEffect(() => {
    const p = products.find(x => x.id === value)
    setText(p ? productLabel(p) : '')
  }, [value, products])

  return (
    <input
      type="text"
      list={listId}
      value={text}
      placeholder={placeholder}
      onChange={e => {
        setText(e.target.value)
        const hit = products.find(p => productLabel(p) === e.target.value)
        onChange(hit ? hit.id : '')
      }}
      className="w-full min-w-0 border border-gray-300 rounded px-2 py-1 text-sm"
    />
  )
}

function BomEditor({ draft, products, onChange, onSave, onCancel, saving, variantCount }: {
  draft: BomDraft
  products: RentalBomProduct[]
  onChange: (d: BomDraft) => void
  onSave: () => void
  onCancel: () => void
  saving: boolean
  /** Packages of this type already on file — decides whether name/default matter. */
  variantCount: number
}) {
  const update = (patch: Partial<BomDraft>) => onChange({ ...draft, ...patch })
  const setItem = (idx: number, patch: Partial<BomDraft['items'][number]>) =>
    update({ items: draft.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)) })
  const addItem = () => update({ items: [...draft.items, { equipmentCategory: RENTAL_EQUIPMENT_CATEGORIES[0]!.value, label: '', qty: 1, productId: '' }] })
  const removeItem = (idx: number) => update({ items: draft.items.filter((_, i) => i !== idx) })
  const listId = `bom-products-${draft.id || `new-${draft.bomType}`}`
  // Another variant of this type exists (or will, once this one saves).
  const hasSiblings = variantCount > (draft.id ? 1 : 0)
  const packageProduct = products.find(p => p.id === draft.packageProductId)

  return (
    <div className="px-4 py-3 bg-blue-50/50 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-800">{BOM_TYPE_LABELS[draft.bomType]} Package{draft.id ? '' : hasSiblings ? ' — new variant' : ''}</span>
        <div className="flex items-center gap-2">
          <button onClick={onCancel} className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1">
            <X className="w-3.5 h-3.5" /> Cancel
          </button>
          <button onClick={onSave} disabled={saving} className="text-xs text-white bg-blue-600 hover:bg-blue-700 px-3 py-1 rounded flex items-center gap-1 disabled:opacity-50">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={draft.name}
          onChange={e => update({ name: e.target.value })}
          placeholder={hasSiblings ? 'Variant name — e.g. w/ gas detection (2 monitors)' : 'Name (optional) — e.g. w/ gas detection'}
          className="flex-1 min-w-[12rem] border border-gray-300 rounded px-2 py-1 text-sm"
        />
        {hasSiblings && (
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={draft.isDefault}
              onChange={e => update({ isDefault: e.target.checked })}
              className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            Dispatch default
          </label>
        )}
      </div>

      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={draft.manned}
            onChange={e => update({ manned: e.target.checked })}
            className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          Manned trailer
        </label>
        {draft.manned && (
          <label className="flex items-center gap-2 text-sm text-gray-600">
            Techs included
            <input
              type="number"
              min={0}
              value={draft.includedTechs}
              onChange={e => update({ includedTechs: e.target.value })}
              className="w-16 border border-gray-300 rounded px-2 py-1 text-sm"
            />
          </label>
        )}
      </div>

      {/* One datalist for every binding in this editor. */}
      <datalist id={listId}>
        {products.map(p => <option key={p.id} value={productLabel(p)} />)}
      </datalist>

      {/* What the package BILLS as. The rows below are its contents — they
          don't charge; only gear deployed beyond them does. */}
      <div className="space-y-1">
        <p className="text-xs font-medium text-gray-500">Billing item for the package</p>
        <ProductBindInput
          value={draft.packageProductId}
          products={products}
          listId={listId}
          placeholder="Search the catalog — leave blank if the package doesn't bill"
          onChange={id => update({ packageProductId: id })}
        />
        <p className="text-[11px] text-gray-400">
          {draft.packageProductId
            ? <>Bills as one line per rental period, at this customer&rsquo;s price level for {packageProduct ? productLabel(packageProduct) : 'this item'}.</>
            : <>Unbound — the package stays descriptive and won&rsquo;t bill. Overages below still can.</>}
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-gray-500">
          Included equipment (baseline)
          <span className="font-normal text-gray-400"> — covered by the package; the item on each row prices an overage</span>
        </p>
        {draft.items.length === 0 && <p className="text-xs text-gray-400 italic">No items yet.</p>}
        {draft.items.map((it, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <select
              value={it.equipmentCategory}
              onChange={e => setItem(idx, { equipmentCategory: e.target.value })}
              className="flex-1 min-w-0 border border-gray-300 rounded px-2 py-1 text-sm bg-white"
            >
              {RENTAL_EQUIPMENT_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <input
              type="number"
              min={1}
              value={it.qty}
              onChange={e => setItem(idx, { qty: parseInt(e.target.value) || 1 })}
              className="w-14 border border-gray-300 rounded px-2 py-1 text-sm"
              title="Quantity"
            />
            <input
              type="text"
              value={it.label}
              onChange={e => setItem(idx, { label: e.target.value })}
              placeholder="Label (optional)"
              className="flex-1 min-w-0 border border-gray-300 rounded px-2 py-1 text-sm"
            />
            <div className="flex-1 min-w-0">
              <ProductBindInput
                value={it.productId}
                products={products}
                listId={listId}
                placeholder="Overage bills as… (optional)"
                onChange={id => setItem(idx, { productId: id })}
              />
            </div>
            <button onClick={() => removeItem(idx)} className="p-1 text-gray-400 hover:text-red-600 rounded flex-shrink-0">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
        <button onClick={addItem} className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1">
          <Plus className="w-3.5 h-3.5" /> Add item
        </button>
      </div>

      <textarea
        value={draft.notes}
        onChange={e => update({ notes: e.target.value })}
        placeholder="Notes (optional)"
        rows={2}
        className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
      />
    </div>
  )
}

function ContactForm({ draft, onChange, onSave, onCancel, saving }: {
  draft: ContactDraft
  onChange: (d: ContactDraft) => void
  onSave: () => void
  onCancel: () => void
  saving: boolean
}) {
  return (
    <div className="px-4 py-3 bg-blue-50/50 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-gray-500 block mb-1">Name *</label>
          <input
            type="text"
            value={draft.name}
            onChange={e => onChange({ ...draft, name: e.target.value })}
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:ring-1 focus:ring-blue-500"
            autoFocus
          />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500 block mb-1">Title</label>
          <input
            type="text"
            value={draft.title}
            onChange={e => onChange({ ...draft, title: e.target.value })}
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500 block mb-1">Phone</label>
          <input
            type="tel"
            value={draft.phone}
            onChange={e => onChange({ ...draft, phone: e.target.value })}
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500 block mb-1">Email</label>
          <input
            type="email"
            value={draft.email}
            onChange={e => onChange({ ...draft, email: e.target.value })}
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500 block mb-1">Role</label>
          <select
            value={draft.role}
            onChange={e => onChange({ ...draft, role: e.target.value })}
            className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:ring-1 focus:ring-blue-500"
          >
            {CONTACT_ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
        </div>
        <div className="flex items-end pb-1">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={draft.isPrimary}
              onChange={e => onChange({ ...draft, isPrimary: e.target.checked })}
              className="rounded"
            />
            Primary Contact
          </label>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onSave}
          disabled={saving || !draft.name.trim()}
          className="text-xs text-white bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded flex items-center gap-1 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          Save Contact
        </button>
        <button onClick={onCancel} className="text-xs text-gray-500 hover:text-gray-700 px-3 py-1.5">
          Cancel
        </button>
      </div>
    </div>
  )
}

type BuyerSiteGroup = {
  customerName: string
  customerDuns: string
  customerUuid: string
  sites: Array<{ siteUuid: string; siteName: string }>
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * BuyerSitePicker — structured replacement for the free-text "Buyer Site UUID" field.
 * OpenInvoice requires buyerSiteUuid to be a GUID; admins were pasting the site LABEL
 * (e.g. "L48 NORTH DAKOTA-0109") which OI rejects. This loads buyers + sites from
 * customer-management and stores the siteUuid (and sets buyerDUNS from the same row so
 * they can't drift apart). Legacy bad values are flagged, with one-click repair when the
 * stored value matches a known site name.
 */
function BuyerSitePicker({ siteUuid, buyerDuns, onPick, inputCls, labelCls }: {
  siteUuid: string
  buyerDuns: string
  onPick: (next: { siteUuid: string; buyerDuns: string }) => void
  inputCls: string
  labelCls: string
}) {
  const [groups, setGroups] = useState<BuyerSiteGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [manual, setManual] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api.get<{ data: BuyerSiteGroup[] }>('/enverus/master-data/buyer-sites')
      .then(res => { if (!cancelled) { setGroups(res?.data || []); setError(null) } })
      .catch((err: any) => { if (!cancelled) setError(err?.message || 'Failed to load buyer sites') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  // Flat lookups across all buyers.
  const allSites = groups.flatMap(g => g.sites.map(s => ({ ...s, customerName: g.customerName, customerDuns: g.customerDuns })))
  const current = allSites.find(s => s.siteUuid === siteUuid)
  const isValidUuid = UUID_RE.test(siteUuid)
  // Legacy value that's a site NAME, not a UUID → offer a one-click fix.
  const nameMatch = !isValidUuid && siteUuid
    ? allSites.find(s => s.siteName.trim().toLowerCase() === siteUuid.trim().toLowerCase())
    : undefined

  const f = filter.trim().toLowerCase()
  const filteredGroups = !f ? groups : groups
    .map(g => ({ ...g, sites: g.sites.filter(s =>
      s.siteName.toLowerCase().includes(f) || g.customerName.toLowerCase().includes(f) || g.customerDuns.includes(f)) }))
    .filter(g => g.sites.length > 0)

  function selectSite(uuid: string) {
    const hit = allSites.find(s => s.siteUuid === uuid)
    if (hit) onPick({ siteUuid: hit.siteUuid, buyerDuns: hit.customerDuns })
  }

  if (manual) {
    return (
      <div>
        <div className="flex items-center justify-between">
          <label className={labelCls}>Buyer Site UUID</label>
          <button type="button" onClick={() => setManual(false)} className="text-xs text-purple-600 hover:underline">use picker</button>
        </div>
        <input type="text" value={siteUuid} onChange={e => onPick({ siteUuid: e.target.value, buyerDuns })} placeholder="paste a site GUID" className={inputCls} />
        {siteUuid && !isValidUuid && <p className="text-xs text-amber-600 mt-0.5 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Not a valid UUID format</p>}
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <label className={labelCls}>Buyer Site {loading && <Loader2 className="w-3 h-3 animate-spin inline ml-1" />}</label>
        <button type="button" onClick={() => setManual(true)} className="text-xs text-gray-400 hover:text-gray-600 hover:underline">enter manually</button>
      </div>
      {groups.length > 5 && (
        <input type="text" value={filter} onChange={e => setFilter(e.target.value)} placeholder="filter buyer or site…" className={inputCls + ' mb-1'} />
      )}
      <select
        value={current ? current.siteUuid : '__none__'}
        onChange={e => { if (e.target.value !== '__none__') selectSite(e.target.value) }}
        className={inputCls}
      >
        <option value="__none__">— select buyer site —</option>
        {filteredGroups.map(g => (
          <optgroup key={g.customerDuns} label={`${g.customerName} (${g.customerDuns})`}>
            {g.sites.map(s => <option key={s.siteUuid} value={s.siteUuid}>{s.siteName}</option>)}
          </optgroup>
        ))}
      </select>
      {error && <p className="text-xs text-red-500 mt-0.5">{error}</p>}
      {current && (
        <p className="text-xs text-green-600 mt-0.5 flex items-center gap-1">
          <Check className="w-3 h-3" /> {current.customerName} → {current.siteName}
        </p>
      )}
      {!current && siteUuid && (
        <div className="text-xs text-amber-600 mt-0.5">
          <p className="flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Stored value <code className="bg-amber-50 px-1 rounded">{siteUuid}</code> {isValidUuid ? 'is not a known site' : 'is not a UUID'}.</p>
          {nameMatch && (
            <button type="button" onClick={() => selectSite(nameMatch.siteUuid)} className="mt-1 text-xs px-2 py-1 rounded border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-800">
              Fix → use {nameMatch.customerName} / {nameMatch.siteName} ({nameMatch.siteUuid.slice(0, 8)}…)
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * EnverusComboField — Enverus-first dropdown with freetext fallback.
 * User clicks "Fetch" to load options from the Enverus master-data API.
 * Shows a <select> + freetext input combo so the user can pick from Enverus or type custom.
 */
function EnverusComboField({ label, value, buyerDuns, endpoint, nameKey, onChangeValue, inputCls, labelCls }: {
  label: string
  value: string
  buyerDuns: string
  endpoint: string  // e.g. 'requisitioners'
  nameKey: string   // e.g. 'formattedName'
  onChangeValue: (v: string) => void
  inputCls: string
  labelCls: string
}) {
  const [options, setOptions] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [fetched, setFetched] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function doFetch() {
    if (!buyerDuns) return
    setLoading(true)
    setError(null)
    api.get(`/enverus/master-data/${endpoint}/${buyerDuns}`)
      .then((res: any) => {
        const items: any[] = res?.data || []
        const names = items.map((r: any) => r[nameKey] || r.name || r.number || r.value || r.formattedName || '').filter(Boolean)
        // Deduplicate
        setOptions([...new Set(names)])
        setFetched(true)
      })
      .catch((err: any) => {
        setError(err?.message || 'Failed to fetch')
        setOptions([])
      })
      .finally(() => setLoading(false))
  }

  return (
    <div>
      <label className={labelCls}>{label}</label>
      <div className="flex gap-1.5">
        {fetched && options.length > 0 ? (
          <select
            value={options.includes(value) ? value : '__custom__'}
            onChange={e => { if (e.target.value !== '__custom__') onChangeValue(e.target.value) }}
            className={inputCls + ' flex-1'}
          >
            <option value="__custom__">{value || '— select from Enverus —'}</option>
            {options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : (
          <input
            type="text"
            value={value}
            onChange={e => onChangeValue(e.target.value)}
            placeholder="Type value or fetch from Enverus →"
            className={inputCls + ' flex-1'}
          />
        )}
        <button
          type="button"
          onClick={doFetch}
          disabled={loading || !buyerDuns}
          className="text-xs px-2.5 py-1.5 rounded border border-purple-300 text-purple-700 bg-purple-50 hover:bg-purple-100 disabled:opacity-40 whitespace-nowrap flex items-center gap-1"
          title={!buyerDuns ? 'Set Buyer DUNS first' : `Fetch ${endpoint} from Enverus`}
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <ExternalLink className="w-3 h-3" />}
          {loading ? 'Fetching...' : fetched ? 'Refresh' : 'Fetch'}
        </button>
      </div>
      {error && <p className="text-xs text-red-500 mt-0.5">{error}</p>}
      {fetched && options.length === 0 && !error && <p className="text-xs text-gray-400 mt-0.5">No options returned from Enverus</p>}
    </div>
  )
}

function BillingProfileForm({ draft, onChange, onSave, onCancel, saving }: {
  draft: BillingProfileDraft
  onChange: (d: BillingProfileDraft) => void
  onSave: () => void
  onCancel: () => void
  saving: boolean
}) {
  const inputCls = 'w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:ring-1 focus:ring-blue-500 focus:border-blue-500'
  const labelCls = 'text-xs font-medium text-gray-500 block mb-1'
  const sectionCls = 'text-xs font-semibold text-gray-600 uppercase tracking-wider'

  return (
    <div className="px-4 py-4 bg-purple-50/40 space-y-4">
      {/* A. Core */}
      <div>
        <p className={sectionCls}>Core</p>
        <div className="grid grid-cols-2 gap-3 mt-2">
          <div>
            <label className={labelCls}>Billing Level *</label>
            <select value={draft.billingLevel} onChange={e => onChange({ ...draft, billingLevel: e.target.value })} className={inputCls}>
              {BILLING_LEVELS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="flex items-end pb-1">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={draft.isActive} onChange={e => onChange({ ...draft, isActive: e.target.checked })} className="rounded" />
              Active
            </label>
          </div>
          <div>
            <label className={labelCls}>Effective From</label>
            <input type="date" value={draft.effectiveFrom} onChange={e => onChange({ ...draft, effectiveFrom: e.target.value })} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Effective To</label>
            <input type="date" value={draft.effectiveTo} onChange={e => onChange({ ...draft, effectiveTo: e.target.value })} className={inputCls} />
          </div>
        </div>
      </div>

      {/* B. Enverus */}
      <div>
        <div className="flex items-center gap-2">
          <p className={sectionCls}>Enverus / OpenInvoice</p>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer ml-auto">
            <input type="checkbox" checked={draft.enverusEnabled} onChange={e => onChange({ ...draft, enverusEnabled: e.target.checked })} className="rounded" />
            Enabled
          </label>
        </div>
        {draft.enverusEnabled && (
          <div className="grid grid-cols-2 gap-3 mt-2">
            <div>
              <label className={labelCls}>Receipt Mode</label>
              <select value={draft.enverusReceiptMode} onChange={e => onChange({ ...draft, enverusReceiptMode: e.target.value })} className={inputCls}>
                {RECEIPT_MODES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Invoice Mode</label>
              <select value={draft.enverusInvoiceMode} onChange={e => onChange({ ...draft, enverusInvoiceMode: e.target.value })} className={inputCls}>
                {INVOICE_MODES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Buyer DUNS</label>
              <input type="text" value={draft.buyerDuns} onChange={e => onChange({ ...draft, buyerDuns: e.target.value })} placeholder="e.g. 074292095" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Buyer DUNS+4</label>
              <input type="text" value={draft.buyerDunsPlus4} onChange={e => onChange({ ...draft, buyerDunsPlus4: e.target.value })} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Buyer Code</label>
              <input type="text" value={draft.buyerCode} onChange={e => onChange({ ...draft, buyerCode: e.target.value })} className={inputCls} />
            </div>
            <div>
              <BuyerSitePicker
                siteUuid={draft.buyerSiteUuid}
                buyerDuns={draft.buyerDuns}
                onPick={({ siteUuid, buyerDuns }) => onChange({ ...draft, buyerSiteUuid: siteUuid, buyerDuns: buyerDuns || draft.buyerDuns })}
                inputCls={inputCls}
                labelCls={labelCls}
              />
            </div>
            <div>
              <label className={labelCls}>Supplier DUNS</label>
              <input type="text" value={draft.supplierDuns} onChange={e => onChange({ ...draft, supplierDuns: e.target.value })} placeholder="016937650" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Supplier Site DUNS+4</label>
              <input type="text" value={draft.supplierSiteDunsPlus4} onChange={e => onChange({ ...draft, supplierSiteDunsPlus4: e.target.value })} className={inputCls} />
            </div>
            <div className="col-span-2">
              <EnverusComboField
                label="Default Requisitioner (orderedByName)"
                value={draft.defaultOrderedByName}
                buyerDuns={draft.buyerDuns}
                endpoint="requisitioners"
                nameKey="formattedName"
                onChangeValue={v => onChange({ ...draft, defaultOrderedByName: v })}
                inputCls={inputCls}
                labelCls={labelCls}
              />
            </div>
            <div className="col-span-2">
              <label className={labelCls}>Facility Property field key</label>
              <input type="text" value={draft.facilityCodeAdfKey} onChange={e => onChange({ ...draft, facilityCodeAdfKey: e.target.value })} placeholder="e.g. Facility Property" className={inputCls} />
              <p className="text-xs text-gray-400 mt-1">Additional-data field (its itemID, code, or name) that receives the well/pad Facility Code on submit. Leave blank to disable per-location injection.</p>
            </div>
            <div className="col-span-2 border-t border-slate-100 pt-3">
              <label className={labelCls}>Additional data fields (buyer custom fields)</label>
              <p className="text-xs text-gray-400 mb-2">
                Buyer-specific custom fields sent on every receipt — e.g. COP's "Activity Code" (major), "Functional Area" (minor), "Invoice Approver". Match the buyer's field-rules label / itemID. <span className="font-medium">Value</span> is the default sent unless a ticket overrides it; leave blank to send the field empty.
              </p>
              {draft.defaultAdditionalDataFields.length > 0 && (
                <div className="grid grid-cols-12 gap-2 px-0.5">
                  <span className="col-span-4 text-[10px] uppercase tracking-wide text-slate-400">Label</span>
                  <span className="col-span-2 text-[10px] uppercase tracking-wide text-slate-400">itemID</span>
                  <span className="col-span-2 text-[10px] uppercase tracking-wide text-slate-400">Code</span>
                  <span className="col-span-3 text-[10px] uppercase tracking-wide text-slate-400">Default value</span>
                  <span className="col-span-1" />
                </div>
              )}
              {draft.defaultAdditionalDataFields.map((adf, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 mt-1 items-center">
                  <input
                    type="text"
                    placeholder="Activity Code"
                    value={adf.name}
                    onChange={e => {
                      const updated = [...draft.defaultAdditionalDataFields]
                      updated[idx] = { ...updated[idx], name: e.target.value }
                      onChange({ ...draft, defaultAdditionalDataFields: updated })
                    }}
                    className={inputCls + ' col-span-4'}
                  />
                  <input
                    type="text"
                    placeholder="99877"
                    value={adf.itemID}
                    onChange={e => {
                      const updated = [...draft.defaultAdditionalDataFields]
                      updated[idx] = { ...updated[idx], itemID: e.target.value }
                      onChange({ ...draft, defaultAdditionalDataFields: updated })
                    }}
                    className={inputCls + ' col-span-2'}
                  />
                  <input
                    type="text"
                    placeholder="—"
                    value={adf.code}
                    onChange={e => {
                      const updated = [...draft.defaultAdditionalDataFields]
                      updated[idx] = { ...updated[idx], code: e.target.value }
                      onChange({ ...draft, defaultAdditionalDataFields: updated })
                    }}
                    className={inputCls + ' col-span-2'}
                  />
                  <input
                    type="text"
                    placeholder="FA-L48"
                    value={adf.value}
                    onChange={e => {
                      const updated = [...draft.defaultAdditionalDataFields]
                      updated[idx] = { ...updated[idx], value: e.target.value }
                      onChange({ ...draft, defaultAdditionalDataFields: updated })
                    }}
                    className={inputCls + ' col-span-3'}
                  />
                  <button
                    onClick={() => onChange({ ...draft, defaultAdditionalDataFields: draft.defaultAdditionalDataFields.filter((_, i) => i !== idx) })}
                    className="text-red-400 hover:text-red-600 p-1 col-span-1 flex justify-center"
                    title="Remove"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
              <button
                onClick={() => onChange({ ...draft, defaultAdditionalDataFields: [...draft.defaultAdditionalDataFields, { name: '', itemID: '', code: '', value: '' }] })}
                className="text-xs text-blue-600 hover:text-blue-800 mt-2 flex items-center gap-1"
              >
                <Plus className="w-3 h-3" /> Add field
              </button>
            </div>
            {(draft.enverusReceiptMode === 'openticket' || draft.enverusReceiptMode === 'both') && (
              <>
                <div className="col-span-2">
                  <label className={labelCls}>Default Service Approver (Open Ticket)</label>
                  <input type="text" value={draft.defaultServiceApprover} onChange={e => onChange({ ...draft, defaultServiceApprover: e.target.value })} placeholder="e.g. Chris Fenstermaker" className={inputCls} />
                </div>
                <div className="col-span-2">
                  <label className={labelCls}>Default Price Book / Contract # (Open Ticket)</label>
                  <input type="text" value={draft.defaultPriceBookNumber} onChange={e => onChange({ ...draft, defaultPriceBookNumber: e.target.value })} placeholder="e.g. 422493 - SOW - Bakken" className={inputCls} />
                </div>
              </>
            )}
            {draft.enverusReceiptMode !== 'none' && (
              <>
                <div className="col-span-2 border-t border-slate-100 pt-3">
                  <label className={labelCls}>Relabeled line fields (buyer vocabulary)</label>
                  <p className="text-xs text-gray-400 mb-2">
                    How this buyer labels the standard Enverus line fields on the submit panel, plus the values that auto-fill at submit (editable per invoice). AFE &amp; Cost Center default values are set under Defaults below.
                  </p>
                  <div className="grid grid-cols-12 gap-2 px-0.5">
                    <span className="col-span-3" />
                    <span className="col-span-5 text-[10px] uppercase tracking-wide text-slate-400">Buyer label</span>
                    <span className="col-span-4 text-[10px] uppercase tracking-wide text-slate-400">Default value</span>
                  </div>
                  <div className="space-y-1.5 mt-1">
                    <div className="grid grid-cols-12 gap-2 items-center">
                      <span className="col-span-3 text-xs text-slate-500">AFE</span>
                      <input type="text" value={draft.labelAfe} onChange={e => onChange({ ...draft, labelAfe: e.target.value })} placeholder="Facility Property" className={inputCls + ' col-span-5'} />
                      <span className="col-span-4 text-[11px] text-slate-400 italic">set as Default AFE # below</span>
                    </div>
                    <div className="grid grid-cols-12 gap-2 items-center">
                      <span className="col-span-3 text-xs text-slate-500">Cost Center</span>
                      <input type="text" value={draft.labelCostCenter} onChange={e => onChange({ ...draft, labelCostCenter: e.target.value })} placeholder="Cost Object" className={inputCls + ' col-span-5'} />
                      <span className="col-span-4 text-[11px] text-slate-400 italic">set as Default Cost Center below</span>
                    </div>
                    <div className="grid grid-cols-12 gap-2 items-center">
                      <span className="col-span-3 text-xs text-slate-500">major</span>
                      <input type="text" value={draft.labelMajor} onChange={e => onChange({ ...draft, labelMajor: e.target.value })} placeholder="Activity Code" className={inputCls + ' col-span-5'} />
                      <input type="text" value={draft.defaultMajor} onChange={e => onChange({ ...draft, defaultMajor: e.target.value })} placeholder="e.g. FA-L48" className={inputCls + ' col-span-4'} />
                    </div>
                    <div className="grid grid-cols-12 gap-2 items-center">
                      <span className="col-span-3 text-xs text-slate-500">minor</span>
                      <input type="text" value={draft.labelMinor} onChange={e => onChange({ ...draft, labelMinor: e.target.value })} placeholder="Functional Area" className={inputCls + ' col-span-5'} />
                      <input type="text" value={draft.defaultMinor} onChange={e => onChange({ ...draft, defaultMinor: e.target.value })} placeholder="e.g. L48_OPS_H_S" className={inputCls + ' col-span-4'} />
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* C. Defaults */}
      <div>
        <p className={sectionCls}>Defaults & Requirements</p>
        <div className="grid grid-cols-2 gap-3 mt-2">
          <div className="col-span-2">
            <EnverusComboField
              label="Default AFE #"
              value={draft.defaultAfeNumber}
              buyerDuns={draft.buyerDuns}
              endpoint="afes"
              nameKey="afeNumber"
              onChangeValue={v => onChange({ ...draft, defaultAfeNumber: v })}
              inputCls={inputCls}
              labelCls={labelCls}
            />
            <FieldSourceSelect value={draft.afeNumberSource} codeLabel="facility code" onChange={v => onChange({ ...draft, afeNumberSource: v })} />
          </div>
          <div className="col-span-2">
            <EnverusComboField
              label="Default Cost Center"
              value={draft.defaultCostCenter}
              buyerDuns={draft.buyerDuns}
              endpoint="cost-centers"
              nameKey="costCenterNumber"
              onChangeValue={v => onChange({ ...draft, defaultCostCenter: v })}
              inputCls={inputCls}
              labelCls={labelCls}
            />
            <FieldSourceSelect value={draft.costCenterSource} codeLabel="cost code" onChange={v => onChange({ ...draft, costCenterSource: v })} />
          </div>
          <div className="col-span-2">
            <EnverusComboField
              label="Default PO #"
              value={draft.defaultPoNumber}
              buyerDuns={draft.buyerDuns}
              endpoint="purchase-orders"
              nameKey="purchaseOrderNumber"
              onChangeValue={v => onChange({ ...draft, defaultPoNumber: v })}
              inputCls={inputCls}
              labelCls={labelCls}
            />
          </div>
          <div className="col-span-2">
            <label className={labelCls}>Subcompany (Enverus buyer site)</label>
            <p className="text-xs text-gray-500">{draft.buyerSiteUuid ? 'Default: the buyer site picked above' : 'No default — pick a buyer site above, or source it from the location'}</p>
            <FieldSourceSelect value={draft.buyerSiteSource} codeLabel="subcompany" defaultLabel="the buyer site above" onChange={v => onChange({ ...draft, buyerSiteSource: v })} />
          </div>
          <div className="col-span-2">
            <label className={labelCls}>Default Department (remit-to, e.g. field office)</label>
            <input type="text" value={draft.defaultBuyerDepartment} onChange={e => onChange({ ...draft, defaultBuyerDepartment: e.target.value })} placeholder="e.g. Killdeer Field Office" className={inputCls} />
            <FieldSourceSelect value={draft.buyerDepartmentSource} codeLabel="department" onChange={v => onChange({ ...draft, buyerDepartmentSource: v })} />
          </div>
          <div>
            <label className={labelCls}>Approval</label>
            <select value={draft.approvalRequired} onChange={e => onChange({ ...draft, approvalRequired: e.target.value })} className={inputCls}>
              {APPROVAL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          {draft.approvalRequired === 'threshold' && (
            <div>
              <label className={labelCls}>Threshold Amount ($)</label>
              <input type="number" step="0.01" min="0" value={draft.approvalThresholdAmount} onChange={e => onChange({ ...draft, approvalThresholdAmount: e.target.value })} className={inputCls} />
            </div>
          )}
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2 pb-1 col-span-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={draft.requiresPo} onChange={e => onChange({ ...draft, requiresPo: e.target.checked })} className="rounded" />
              Requires PO
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={draft.requiresAfe} onChange={e => onChange({ ...draft, requiresAfe: e.target.checked })} className="rounded" />
              Requires AFE
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={draft.requiresCostCenter} onChange={e => onChange({ ...draft, requiresCostCenter: e.target.checked })} className="rounded" />
              Requires Cost Center
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={draft.requiresBuyerSite} onChange={e => onChange({ ...draft, requiresBuyerSite: e.target.checked })} className="rounded" />
              Requires Subcompany
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={draft.requiresBuyerDepartment} onChange={e => onChange({ ...draft, requiresBuyerDepartment: e.target.checked })} className="rounded" />
              Requires Department
            </label>
          </div>

          {/* #4 Job-type scope — leave both empty for a company-wide default. */}
          <div className="col-span-2 border-t border-slate-100 pt-3">
            <p className="text-xs text-slate-500 mb-2">
              Applies to <span className="font-medium">(leave all unchecked = company-wide default)</span>
            </p>
            <div className="flex flex-wrap gap-x-6 gap-y-3">
              <div>
                <span className={labelCls}>Ticket types</span>
                <div className="flex flex-wrap gap-2 mt-1">
                  {(['field_service', 'sale', 'rental', 'repair', 'inspection', 'ih_sampling', 'training'] as const).map(tt => (
                    <label key={tt} className="flex items-center gap-1.5 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={draft.appliesToTicketTypes.includes(tt)}
                        onChange={e => onChange({
                          ...draft,
                          appliesToTicketTypes: e.target.checked
                            ? [...draft.appliesToTicketTypes, tt]
                            : draft.appliesToTicketTypes.filter(x => x !== tt),
                        })}
                        className="rounded"
                      />
                      {tt === 'ih_sampling' ? 'IH → Sampling' : tt.replace(/_/g, ' ')}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <span className={labelCls}>Divisions</span>
                <div className="flex flex-wrap gap-2 mt-1">
                  {(['D3', 'D4'] as const).map(d => (
                    <label key={d} className="flex items-center gap-1.5 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={draft.appliesToDivisions.includes(d)}
                        onChange={e => onChange({
                          ...draft,
                          appliesToDivisions: e.target.checked
                            ? [...draft.appliesToDivisions, d]
                            : draft.appliesToDivisions.filter(x => x !== d),
                        })}
                        className="rounded"
                      />
                      {d}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* D. Signature Requirements */}
      <div>
        <p className={sectionCls}>Signature Requirements</p>
        <div className="grid grid-cols-2 gap-3 mt-2">
          <div>
            <label className={labelCls}>Signature Required</label>
            <select value={draft.signatureRequired} onChange={e => onChange({ ...draft, signatureRequired: e.target.value })} className={inputCls}>
              <option value="none">None</option>
              <option value="ticket">Ticket Only</option>
              <option value="invoice">Invoice Only</option>
              <option value="both">Ticket & Invoice</option>
            </select>
          </div>
        </div>
        {draft.signatureRequired !== 'none' && (
          <div className="mt-3">
            <label className={labelCls}>Approvers (name + email)</label>
            {draft.signatureApprovers.map((approver, idx) => (
              <div key={idx} className="flex items-center gap-2 mt-1">
                <input
                  type="text"
                  placeholder="Name"
                  value={approver.name}
                  onChange={e => {
                    const updated = [...draft.signatureApprovers]
                    updated[idx] = { ...updated[idx], name: e.target.value }
                    onChange({ ...draft, signatureApprovers: updated })
                  }}
                  className={inputCls + ' flex-1'}
                />
                <input
                  type="email"
                  placeholder="Email"
                  value={approver.email}
                  onChange={e => {
                    const updated = [...draft.signatureApprovers]
                    updated[idx] = { ...updated[idx], email: e.target.value }
                    onChange({ ...draft, signatureApprovers: updated })
                  }}
                  className={inputCls + ' flex-1'}
                />
                <button
                  onClick={() => {
                    const updated = draft.signatureApprovers.filter((_, i) => i !== idx)
                    onChange({ ...draft, signatureApprovers: updated })
                  }}
                  className="text-red-400 hover:text-red-600 p-1"
                  title="Remove"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            <button
              onClick={() => onChange({ ...draft, signatureApprovers: [...draft.signatureApprovers, { name: '', email: '' }] })}
              className="text-xs text-blue-600 hover:text-blue-800 mt-2 flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> Add Approver
            </button>
          </div>
        )}
      </div>

      {/* E. Stacked Billing */}
      <div>
        <div className="flex items-center gap-2">
          <p className={sectionCls}>Stacked Billing</p>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer ml-auto">
            <input type="checkbox" checked={draft.stackedBillingEnabled} onChange={e => onChange({ ...draft, stackedBillingEnabled: e.target.checked })} className="rounded" />
            Enabled
          </label>
        </div>
        {draft.stackedBillingEnabled && (
          <div className="grid grid-cols-3 gap-3 mt-2">
            <div>
              <label className={labelCls}>Group By</label>
              <input type="text" value={draft.stackedBillingGroupBy} onChange={e => onChange({ ...draft, stackedBillingGroupBy: e.target.value })} placeholder="e.g. well, pad" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Period</label>
              <select value={draft.stackedBillingPeriod} onChange={e => onChange({ ...draft, stackedBillingPeriod: e.target.value })} className={inputCls}>
                {STACKED_PERIODS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Fiscal Month Start</label>
              <input type="number" min="1" max="12" value={draft.stackedBillingFiscalMonthStart} onChange={e => onChange({ ...draft, stackedBillingFiscalMonthStart: e.target.value })} placeholder="1-12" className={inputCls} />
            </div>
          </div>
        )}
      </div>

      {/* Notes */}
      <div>
        <label className="text-xs font-medium text-gray-500 block mb-1">Notes</label>
        <textarea
          value={draft.notes}
          onChange={e => onChange({ ...draft, notes: e.target.value })}
          rows={2}
          placeholder="Optional notes about this billing profile"
          className={inputCls}
        />
      </div>

      {/* Save / Cancel */}
      <div className="flex items-center gap-2">
        <button
          onClick={onSave}
          disabled={saving}
          className="text-xs text-white bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded flex items-center gap-1 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          Save Profile
        </button>
        <button onClick={onCancel} className="text-xs text-gray-500 hover:text-gray-700 px-3 py-1.5">
          Cancel
        </button>
      </div>
    </div>
  )
}
