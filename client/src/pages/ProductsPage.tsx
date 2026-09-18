import { useState, useEffect, useRef } from 'react'
import { api } from '@/lib/api'
import { useAuth } from '@/contexts/AuthContext'
import { hasPermission } from '@/lib/permissions'
import { Search, Package, Upload, CheckCircle, AlertTriangle, Pencil, Check, X } from 'lucide-react'

interface Product {
  id: string
  name: string
  partNumber: string
  category: string
  productType: string
  defaultSellPrice: number | null
  qbItemFullName: string | null
  enverusProductServiceCode: string | null
  isActive: boolean
}

interface ImportResult {
  imported: number
  skipped: number
  errors: number
  errorSamples: string[]
  totalRows: number
}

export function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([])
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editCode, setEditCode] = useState('')
  const [editPrice, setEditPrice] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { user } = useAuth()
  const canManage = hasPermission(user?.role, 'products:manage')

  useEffect(() => {
    loadProducts()
  }, [search])

  async function loadProducts() {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: '100', active: 'true' })
      if (search) params.set('search', search)
      const data = await api.get<{ data: Product[], total: number }>(`/products?${params}`)
      setProducts(data.data)
      setTotal(data.total)
    } catch {
      setProducts([])
    } finally {
      setLoading(false)
    }
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImporting(true)
    setImportResult(null)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const result = await api.upload<ImportResult>('/products/import-qb-csv', formData)
      setImportResult(result)
      loadProducts() // refresh list
    } catch (err: any) {
      setImportResult({ imported: 0, skipped: 0, errors: 1, errorSamples: [err.message || 'Upload failed'], totalRows: 0 })
    } finally {
      setImporting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  function startEdit(p: Product) {
    setEditingId(p.id)
    setEditCode(p.enverusProductServiceCode || '')
    setEditPrice(p.defaultSellPrice != null ? String(p.defaultSellPrice) : '')
  }

  async function saveEdit() {
    if (!editingId) return
    try {
      const payload: Record<string, any> = {
        enverusProductServiceCode: editCode.trim() || null,
      }
      if (editPrice.trim()) payload.defaultSellPrice = parseFloat(editPrice)
      await api.put(`/products/${editingId}`, payload)
      setEditingId(null)
      loadProducts()
    } catch (err: any) {
      alert('Save failed: ' + (err?.message || 'Unknown'))
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Products</h1>
          {!loading && <p className="text-sm text-slate-500">{total} active products</p>}
        </div>
        {canManage && (
          <div>
            <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={handleImport} />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 text-sm font-medium"
            >
              <Upload className="w-4 h-4" />
              {importing ? 'Importing...' : 'Import QB Items'}
            </button>
          </div>
        )}
      </div>

      {/* Import Result Banner */}
      {importResult && (
        <div className={`mb-4 p-4 rounded-lg border ${importResult.errors > 0 && importResult.imported === 0 ? 'bg-red-50 border-red-200' : 'bg-emerald-50 border-emerald-200'}`}>
          <div className="flex items-start gap-3">
            {importResult.errors > 0 && importResult.imported === 0 ? (
              <AlertTriangle className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />
            ) : (
              <CheckCircle className="w-5 h-5 text-emerald-600 mt-0.5 shrink-0" />
            )}
            <div>
              <p className="font-medium text-slate-900">
                Import complete: {importResult.imported} imported, {importResult.skipped} skipped
                {importResult.errors > 0 && `, ${importResult.errors} errors`}
              </p>
              {importResult.errorSamples.length > 0 && (
                <ul className="mt-1 text-sm text-red-700">
                  {importResult.errorSamples.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              )}
            </div>
            <button onClick={() => setImportResult(null)} className="ml-auto text-slate-400 hover:text-slate-600 text-lg leading-none">&times;</button>
          </div>
        </div>
      )}

      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or part number..."
          className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
        />
      </div>

      {loading ? (
        <div className="text-center py-12 text-slate-400">Loading...</div>
      ) : products.length === 0 ? (
        <div className="text-center py-12 text-slate-400">No products found</div>
      ) : (
        <div className="space-y-2">
          {products.map(product => {
            const isEditing = editingId === product.id
            return (
              <div key={product.id} className="bg-white rounded-lg border border-slate-200 p-4 hover:border-slate-300 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
                    <Package className="w-5 h-5 text-blue-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-slate-900">{product.name}</p>
                    <div className="flex items-center gap-2 text-sm text-slate-500 flex-wrap">
                      <span className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">{product.partNumber}</span>
                      <span>{product.category.replace(/_/g, ' ')}</span>
                      {product.qbItemFullName && (
                        <span className="text-emerald-600 text-xs">QB: {product.qbItemFullName}</span>
                      )}
                      {!product.qbItemFullName && (
                        <span className="text-amber-600 text-xs">No QB mapping</span>
                      )}
                      {!isEditing && (
                        <span className={`text-xs px-1.5 py-0.5 rounded ${product.enverusProductServiceCode ? 'bg-purple-50 text-purple-600' : 'bg-red-50 text-red-500'}`}>
                          OI: {product.enverusProductServiceCode || 'none'}
                        </span>
                      )}
                    </div>
                  </div>
                  {!isEditing && (
                    <div className="flex items-center gap-2 shrink-0">
                      {product.defaultSellPrice != null && Number(product.defaultSellPrice) > 0 && (
                        <div className="text-sm font-mono font-medium text-slate-700">
                          ${Number(product.defaultSellPrice).toFixed(2)}
                        </div>
                      )}
                      {canManage && (
                        <button onClick={() => startEdit(product)} className="p-1.5 text-slate-400 hover:text-blue-600 rounded">
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {isEditing && (
                  <div className="mt-3 pt-3 border-t border-slate-100 flex items-end gap-3">
                    <div className="flex-1">
                      <label className="text-[10px] font-medium text-slate-500 block mb-1">Enverus Product/Service Code</label>
                      <input
                        type="text"
                        value={editCode}
                        onChange={e => setEditCode(e.target.value)}
                        placeholder="e.g. MISC, SAFETY, RENTAL"
                        className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                        autoFocus
                        onKeyDown={e => e.key === 'Enter' && saveEdit()}
                      />
                    </div>
                    <div className="w-28">
                      <label className="text-[10px] font-medium text-slate-500 block mb-1">Sell Price</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={editPrice}
                        onChange={e => setEditPrice(e.target.value)}
                        placeholder="0.00"
                        className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                        onKeyDown={e => e.key === 'Enter' && saveEdit()}
                      />
                    </div>
                    <button onClick={saveEdit} className="p-1.5 text-green-600 hover:text-green-800 rounded">
                      <Check className="w-4 h-4" />
                    </button>
                    <button onClick={() => setEditingId(null)} className="p-1.5 text-slate-400 hover:text-slate-600 rounded">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
