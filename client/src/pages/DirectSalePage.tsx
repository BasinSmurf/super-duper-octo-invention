import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Elements } from '@stripe/react-stripe-js'
import { type Stripe } from '@stripe/stripe-js'
import { getStripe } from '@/lib/stripe'
import { api } from '@/lib/api'
import { PaymentForm } from '@/components/PaymentForm'
import { ProductSearch } from '@/components/ProductSearch'
import { CustomerSearch } from '@/components/CustomerSearch'
import { BarcodeScanner } from '@/components/BarcodeScanner'
import { SignaturePad } from '@/components/SignaturePad'
import {
  ShoppingCart, Trash2, Plus, Minus, CreditCard, Banknote, Receipt,
  CheckCircle, Barcode, Printer, FileText,
} from 'lucide-react'
import { DEFAULT_CC_FEE_PCT } from '@/lib/taxJurisdictions'
import { WORK_TYPE_DIVISION } from '@/lib/divisions'

interface CartItem {
  productId: string
  name: string
  partNumber: string
  unitPrice: number
  quantity: number
  taxable: boolean
}

type PaymentMethodType = 'card' | 'cash' | 'check' | 'invoice'

export function DirectSalePage() {
  const [stripePromise, setStripePromise] = useState<Promise<Stripe | null> | null>(null)
  const [cart, setCart] = useState<CartItem[]>([])
  const [customer, setCustomer] = useState<any>(null)
  const [notes, setNotes] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodType>('card')
  const [showScanner, setShowScanner] = useState(false)
  const [saleComplete, setSaleComplete] = useState(false)
  const [lastPayment, setLastPayment] = useState<any>(null)
  const [cashProcessing, setCashProcessing] = useState(false)
  const [signature, setSignature] = useState<string | null>(null)

  // Tax — jurisdictions come from the server SalesTaxRate table so the slug +
  // QB tax-item name line up with what the receipt push needs.
  const [taxRates, setTaxRates] = useState<Array<{ id: string; name: string; rate: number }>>([])
  const [taxJurisdiction, setTaxJurisdiction] = useState('williston')

  // CC convenience fee
  const [ccFeePct, setCcFeePct] = useState(DEFAULT_CC_FEE_PCT)

  // Snapshot of completed sale for receipt printing
  const saleSnapshot = useRef<{
    cart: CartItem[]
    subtotal: number
    taxableSubtotal: number
    tax: number
    ccFee: number
    total: number
    taxJurisdictionName: string
    taxRate: number
    paymentMethod: string
    customer: any
    notes: string
    date: string
  } | null>(null)

  useEffect(() => {
    setStripePromise(getStripe())
  }, [])

  useEffect(() => {
    api.get<{ data: Array<{ id: string; name: string; rate: any }> }>('/sales-tax-rates?activeOnly=1')
      .then(res => {
        const rows = (res.data || []).map(r => ({ id: r.id, name: r.name, rate: Number(r.rate) || 0 }))
        setTaxRates(rows)
        // Default to Williston when present, otherwise the first jurisdiction.
        if (!rows.some(r => r.id === 'williston') && rows[0]) setTaxJurisdiction(rows[0].id)
      })
      .catch(() => { /* leave dropdown empty; tax stays 0 until a row loads */ })
  }, [])

  const taxRate = useMemo(() => {
    return taxRates.find(j => j.id === taxJurisdiction)?.rate || 0
  }, [taxRates, taxJurisdiction])

  const subtotal = cart.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)
  const taxableSubtotal = cart.reduce(
    (sum, item) => sum + (item.taxable ? item.unitPrice * item.quantity : 0), 0
  )
  const tax = taxableSubtotal * taxRate
  const ccFee = paymentMethod === 'card' ? (subtotal + tax) * (ccFeePct / 100) : 0
  const total = subtotal + tax + ccFee

  function addProduct(product: any) {
    setCart(prev => {
      const existing = prev.find(i => i.productId === product.id)
      if (existing) {
        return prev.map(i =>
          i.productId === product.id ? { ...i, quantity: i.quantity + 1 } : i
        )
      }
      // Products (physical goods) default taxable; services do not.
      // category === 'service' → not taxable; everything else → taxable
      const isTaxable = product.category !== 'service'
      return [...prev, {
        productId: product.id,
        name: product.name,
        partNumber: product.partNumber,
        unitPrice: product.defaultSellPrice || 0,
        quantity: 1,
        taxable: isTaxable,
      }]
    })
  }

  function updateQuantity(productId: string, delta: number) {
    setCart(prev =>
      prev
        .map(i => i.productId === productId ? { ...i, quantity: Math.max(0, i.quantity + delta) } : i)
        .filter(i => i.quantity > 0)
    )
  }

  function removeItem(productId: string) {
    setCart(prev => prev.filter(i => i.productId !== productId))
  }

  function updatePrice(productId: string, price: number) {
    setCart(prev =>
      prev.map(i => i.productId === productId ? { ...i, unitPrice: price } : i)
    )
  }

  function toggleTaxable(productId: string) {
    setCart(prev =>
      prev.map(i => i.productId === productId ? { ...i, taxable: !i.taxable } : i)
    )
  }

  // Pre-tax basket snapshot sent to the server so the QB receipt is rebuilt from
  // real lines + ItemSalesTaxRef (QB recomputes tax). The CC convenience fee
  // rides as a separate non-taxable line so the receipt total matches the charge.
  function buildSaleLineItems() {
    const items: Array<{ productId: string | null; description: string; quantity: number; unitPrice: number; taxable: boolean }> =
      cart.map(i => ({
        productId: i.productId,
        description: i.name,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        taxable: i.taxable,
      }))
    if (paymentMethod === 'card' && ccFee > 0) {
      items.push({
        productId: null,
        description: `Convenience fee (${ccFeePct}%)`,
        quantity: 1,
        unitPrice: Math.round(ccFee * 100) / 100,
        taxable: false,
      })
    }
    return items
  }

  function captureSaleSnapshot() {
    const jurName = taxRates.find(j => j.id === taxJurisdiction)?.name || ''
    saleSnapshot.current = {
      cart: [...cart],
      subtotal,
      taxableSubtotal,
      tax,
      ccFee,
      total,
      taxJurisdictionName: jurName,
      taxRate,
      paymentMethod,
      customer,
      notes,
      date: new Date().toLocaleString(),
    }
  }

  const handlePaymentSuccess = useCallback((payment: any) => {
    captureSaleSnapshot()
    setLastPayment(payment)
    setSaleComplete(true)
  }, [cart, subtotal, taxableSubtotal, tax, ccFee, total, taxRate, taxJurisdiction, paymentMethod, customer, notes])

  async function handleCashPayment() {
    if (total <= 0 || cashProcessing) return
    setCashProcessing(true)
    try {
      const payment = await api.post('/payments/cash', {
        amount: total,
        paymentMethod,
        companyId: customer?.id || null,
        signature: paymentMethod === 'invoice' ? signature : null,
        description: notes || `Direct sale — ${cart.length} items`,
        lineItems: buildSaleLineItems(),
        taxJurisdictionId: taxJurisdiction || null,
      })
      captureSaleSnapshot()
      setLastPayment(payment)
      setSaleComplete(true)
    } catch (err: any) {
      alert(err.message || 'Payment recording failed')
    } finally {
      setCashProcessing(false)
    }
  }

  function printReceipt() {
    const s = saleSnapshot.current
    if (!s) return
    const w = window.open('', '_blank', 'width=400,height=600')
    if (!w) return
    const lines = s.cart.map(i =>
      `<tr>
        <td style="padding:2px 8px 2px 0">${i.name}${i.taxable ? ' *' : ''}</td>
        <td style="text-align:center">${i.quantity}</td>
        <td style="text-align:right">$${(i.unitPrice * i.quantity).toFixed(2)}</td>
      </tr>`
    ).join('')
    w.document.write(`<!DOCTYPE html><html><head><title>Receipt</title>
      <style>body{font-family:monospace;font-size:13px;padding:20px;max-width:360px;margin:0 auto}
      h2{text-align:center;margin-bottom:4px}table{width:100%;border-collapse:collapse}
      .sep{border-top:1px dashed #999;margin:8px 0}.tot{font-weight:bold;font-size:15px}
      @media print{button{display:none}}</style></head><body>
      <h2>Basin Safety</h2>
      <p style="text-align:center;font-size:11px">Williston, ND &bull; (701) 572-8222</p>
      <p style="text-align:center;font-size:11px">${s.date}</p>
      ${s.customer ? `<p>Customer: ${s.customer.name || s.customer.companyName || ''}</p>` : ''}
      <div class="sep"></div>
      <table><tbody>${lines}</tbody></table>
      <div class="sep"></div>
      <table>
        <tr><td>Subtotal</td><td style="text-align:right">$${s.subtotal.toFixed(2)}</td></tr>
        ${s.tax > 0 ? `<tr><td>Tax (${(s.taxRate * 100).toFixed(2)}%)</td><td style="text-align:right">$${s.tax.toFixed(2)}</td></tr>` : ''}
        ${s.ccFee > 0 ? `<tr><td>Convenience Fee</td><td style="text-align:right">$${s.ccFee.toFixed(2)}</td></tr>` : ''}
        <tr class="tot"><td>Total</td><td style="text-align:right">$${s.total.toFixed(2)}</td></tr>
      </table>
      <div class="sep"></div>
      <p>Paid: ${s.paymentMethod === 'card' ? 'Credit Card' : s.paymentMethod === 'cash' ? 'Cash' : 'Check'}</p>
      ${s.notes ? `<p>Notes: ${s.notes}</p>` : ''}
      <p style="font-size:10px;margin-top:4px">* = taxable item</p>
      <div class="sep"></div>
      <p style="text-align:center;font-size:11px">Thank you!</p>
      <button onclick="window.print()" style="margin:16px auto;display:block;padding:8px 24px;cursor:pointer">Print</button>
      </body></html>`)
    w.document.close()
  }

  function resetSale() {
    saleSnapshot.current = null
    setCart([])
    setCustomer(null)
    setNotes('')
    setPaymentMethod('card')
    setSignature(null)
    setSaleComplete(false)
    setLastPayment(null)
  }

  function handleBarcodeScan(code: string) {
    setShowScanner(false)
    api.get<{ data: any[] }>(`/products?search=${encodeURIComponent(code)}&limit=1`)
      .then(res => {
        const products = res.data || res as any
        const match = Array.isArray(products) ? products[0] : null
        if (match) {
          addProduct(match)
        } else {
          alert(`No product found for barcode: ${code}`)
        }
      })
      .catch(() => alert(`Product lookup failed for: ${code}`))
  }

  // ── Sale Complete Screen ──
  if (saleComplete) {
    return (
      <div className="max-w-lg mx-auto py-12 text-center space-y-6">
        <CheckCircle className="w-20 h-20 text-green-500 mx-auto" />
        <h2 className="text-2xl font-bold text-slate-800">Sale Complete</h2>
        <p className="text-slate-600">
          ${total.toFixed(2)} — {paymentMethod === 'card' ? 'Card' : paymentMethod === 'cash' ? 'Cash' : paymentMethod === 'invoice' ? 'Invoice' : 'Check'}
        </p>
        {lastPayment?.stripeReceiptUrl && (
          <a
            href={lastPayment.stripeReceiptUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 underline text-sm"
          >
            View Stripe Receipt
          </a>
        )}
        <div className="flex gap-3 justify-center">
          <button
            onClick={printReceipt}
            className="px-6 py-3 bg-slate-100 text-slate-700 font-semibold rounded-lg hover:bg-slate-200 flex items-center gap-2"
          >
            <Printer className="w-5 h-5" />
            Print Receipt
          </button>
          <button
            onClick={resetSale}
            className="px-6 py-3 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700"
          >
            New Sale
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
          <ShoppingCart className="w-6 h-6" />
          Direct Sale
        </h1>
        <span className="text-2xl font-bold text-blue-600">${total.toFixed(2)}</span>
      </div>

      {/* Customer + Product Search */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
        <div>
          <label className="text-sm font-medium text-slate-600 mb-1 block">
            Customer {paymentMethod === 'invoice' ? '(required for invoice)' : '(optional)'}
          </label>
          <CustomerSearch value={customer} onChange={setCustomer} />
        </div>
        <div className="flex gap-2">
          <div className="flex-1">
            <ProductSearch
              onSelect={addProduct}
              placeholder="Search or scan products..."
              division={WORK_TYPE_DIVISION.direct_sale}
            />
          </div>
          <button
            onClick={() => setShowScanner(!showScanner)}
            className="px-3 py-2 bg-slate-100 rounded-lg hover:bg-slate-200 text-slate-600"
            title="Scan barcode"
          >
            <Barcode className="w-5 h-5" />
          </button>
        </div>
        {showScanner && (
          <BarcodeScanner
            onScan={handleBarcodeScan}
            onClose={() => setShowScanner(false)}
          />
        )}
      </div>

      {/* Cart */}
      <div className="bg-white rounded-xl border border-slate-200">
        {cart.length === 0 ? (
          <p className="p-8 text-center text-slate-400">No items yet — search or scan to add products</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {/* Column headers */}
            <div className="flex items-center gap-3 px-3 py-2 text-xs font-medium text-slate-400 uppercase">
              <span className="flex-1">Item</span>
              <span className="w-10 text-center">Tax</span>
              <span className="w-24 text-center">Qty</span>
              <span className="w-24 text-right">Price</span>
              <span className="w-20 text-right">Total</span>
              <span className="w-6" />
            </div>

            {cart.map(item => (
              <div key={item.productId} className="flex items-center gap-3 p-3">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-slate-800 truncate">{item.name}</p>
                  <p className="text-xs text-slate-400">{item.partNumber}</p>
                </div>

                {/* Taxable checkbox */}
                <div className="w-10 flex justify-center">
                  <input
                    type="checkbox"
                    checked={item.taxable}
                    onChange={() => toggleTaxable(item.productId)}
                    className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                    title={item.taxable ? 'Taxable' : 'Not taxable'}
                  />
                </div>

                {/* Quantity controls */}
                <div className="w-24 flex items-center justify-center gap-1">
                  <button
                    onClick={() => updateQuantity(item.productId, -1)}
                    className="w-7 h-7 flex items-center justify-center rounded bg-slate-100 hover:bg-slate-200"
                  >
                    <Minus className="w-3 h-3" />
                  </button>
                  <span className="w-8 text-center text-sm font-medium">{item.quantity}</span>
                  <button
                    onClick={() => updateQuantity(item.productId, 1)}
                    className="w-7 h-7 flex items-center justify-center rounded bg-slate-100 hover:bg-slate-200"
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                </div>

                {/* Unit price (editable) */}
                <div className="w-24">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={item.unitPrice}
                    onChange={e => updatePrice(item.productId, parseFloat(e.target.value) || 0)}
                    className="w-full text-right text-sm border border-slate-200 rounded px-2 py-1"
                  />
                </div>

                {/* Line total */}
                <span className="w-20 text-right font-medium text-sm">
                  ${(item.unitPrice * item.quantity).toFixed(2)}
                </span>

                <button
                  onClick={() => removeItem(item.productId)}
                  className="text-slate-400 hover:text-red-500"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}

            {/* Totals */}
            <div className="p-4 space-y-1 bg-slate-50">
              <div className="flex justify-between text-sm text-slate-600">
                <span>Subtotal</span>
                <span>${subtotal.toFixed(2)}</span>
              </div>
              {taxableSubtotal > 0 && taxRate > 0 && (
                <div className="flex justify-between text-sm text-slate-600">
                  <span>
                    Tax ({(taxRate * 100).toFixed(taxRate * 100 % 1 === 0 ? 0 : 2)}%
                    on ${taxableSubtotal.toFixed(2)} taxable)
                  </span>
                  <span>${tax.toFixed(2)}</span>
                </div>
              )}
              {taxableSubtotal > 0 && taxRate === 0 && (
                <div className="flex justify-between text-sm text-slate-400">
                  <span>Tax (exempt)</span>
                  <span>$0.00</span>
                </div>
              )}
              {paymentMethod === 'card' && ccFee > 0 && (
                <div className="flex justify-between text-sm text-slate-600">
                  <span>Convenience fee ({ccFeePct}%)</span>
                  <span>${ccFee.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between text-lg font-bold text-slate-800 pt-1 border-t border-slate-200">
                <span>Total</span>
                <span>${total.toFixed(2)}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Tax Jurisdiction + Notes */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="text-sm font-medium text-slate-600 mb-1 block">Tax Jurisdiction</label>
            <select
              value={taxJurisdiction}
              onChange={e => setTaxJurisdiction(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white"
            >
              {taxRates.map(j => (
                <option key={j.id} value={j.id}>{j.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-sm font-medium text-slate-600 mb-1 block">Notes</label>
            <input
              type="text"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Optional notes..."
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-slate-600 mb-1 block">Convenience Fee %</label>
            <input
              type="number"
              step="0.5"
              min="0"
              max="10"
              value={ccFeePct}
              onChange={e => setCcFeePct(parseFloat(e.target.value) || 0)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            />
          </div>
        </div>
      </div>

      {/* Payment Method Selector */}
      {cart.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-4">
          <div className="flex gap-2">
            {([
              { key: 'card' as const, label: 'Card', icon: CreditCard },
              { key: 'cash' as const, label: 'Cash', icon: Banknote },
              { key: 'check' as const, label: 'Check', icon: Receipt },
              { key: 'invoice' as const, label: 'Invoice', icon: FileText },
            ]).map(m => (
              <button
                key={m.key}
                onClick={() => setPaymentMethod(m.key)}
                className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-lg font-medium text-sm border-2 transition-colors ${
                  paymentMethod === m.key
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-slate-200 text-slate-600 hover:border-slate-300'
                }`}
              >
                <m.icon className="w-5 h-5" />
                {m.label}
              </button>
            ))}
          </div>

          {/* Card Payment (Stripe) */}
          {paymentMethod === 'card' && stripePromise && (
            <Elements stripe={stripePromise}>
              <PaymentForm
                amount={total}
                description={notes || `Direct sale — ${cart.length} items`}
                companyId={customer?.id || null}
                lineItems={buildSaleLineItems()}
                taxJurisdictionId={taxJurisdiction || null}
                onSuccess={handlePaymentSuccess}
                disabled={total <= 0}
              />
            </Elements>
          )}

          {/* Cash / Check */}
          {(paymentMethod === 'cash' || paymentMethod === 'check') && (
            <button
              onClick={handleCashPayment}
              disabled={total <= 0 || cashProcessing}
              className="w-full py-3 px-4 bg-green-600 text-white font-semibold rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {cashProcessing
                ? 'Recording...'
                : `Complete Sale — $${total.toFixed(2)} (${paymentMethod === 'cash' ? 'Cash' : 'Check'})`
              }
            </button>
          )}

          {/* Invoice — requires customer + signature */}
          {paymentMethod === 'invoice' && (
            <div className="space-y-4">
              {!customer && (
                <p className="text-sm text-amber-600 font-medium">
                  ⚠ Select a customer above to invoice
                </p>
              )}
              <SignaturePad
                value={signature}
                onChange={setSignature}
                label="Customer Signature"
              />
              <button
                onClick={handleCashPayment}
                disabled={total <= 0 || !customer || !signature || cashProcessing}
                className="w-full py-3 px-4 bg-indigo-600 text-white font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {cashProcessing
                  ? 'Recording...'
                  : `Create Invoice — $${total.toFixed(2)}`
                }
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
