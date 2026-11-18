import { useBranding } from '@/lib/branding'

export function CompanyBrand({ className = 'h-9 w-auto', containerClassName = '' }: { className?: string; containerClassName?: string }) {
  const { branding } = useBranding()
  return <span className={`inline-flex max-w-full min-w-0 flex-col items-start gap-1 ${containerClassName}`}>
    <img src={branding.logoUrl} alt={`${branding.companyName} logo`} className={className}
      onError={event => { if (!event.currentTarget.src.endsWith('/servicepro-logo.png')) event.currentTarget.src = '/servicepro-logo.png' }} />
    <span className="max-w-full truncate text-xs text-slate-600">{branding.companyName}</span>
  </span>
}
