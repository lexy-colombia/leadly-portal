export function PageSpinner() {
  return (
    <div className="flex h-full min-h-[40vh] w-full items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-200 border-t-accent-500" />
    </div>
  )
}
