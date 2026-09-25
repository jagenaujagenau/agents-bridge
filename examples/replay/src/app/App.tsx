import { useEffect, useState } from "react"
import { SessionView } from "../views/SessionView.tsx"
import { SessionPicker } from "../views/SessionPicker.tsx"
import { FleetView } from "../views/FleetView.tsx"
import { parseRoute } from "./routes.ts"

export const App = () => {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash))
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash))
    window.addEventListener("hashchange", onChange)
    return () => window.removeEventListener("hashchange", onChange)
  }, [])
  if (route.page === "fleet") return <FleetView key={route.session ?? route.project ?? ""} project={route.project} session={route.session} />
  return route.page === "picker" ? <SessionPicker /> : <SessionView key={route.id} route={route} />
}
