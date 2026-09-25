import { modelLabel, vendorOf } from "../models/vendors.ts"

/** A vendor's mark: its logo when one is available, otherwise a letter badge. */
export const VendorIcon = ({ model }: { readonly model: string }) => {
  const vendor = vendorOf(model)
  return vendor.path !== undefined
    ? (
      <svg className="vendor" viewBox="0 0 24 24" role="img" aria-label={vendor.name}>
        <path d={vendor.path} />
      </svg>
    )
    : <span className="vendor vendor--letter" role="img" aria-label={vendor.name}>{vendor.letter}</span>
}

export const ModelBadge = ({ model }: { readonly model: string }) => (
  <span className="model">
    <VendorIcon model={model} />
    <span className="clip">{modelLabel(model)}</span>
  </span>
)
