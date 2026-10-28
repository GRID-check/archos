/** One organization the person may switch to, as the avatar menu lists it. */
export interface SwitchableOrganization {
  id: string
  name: string
  /** The organization the session is in now. */
  current: boolean
}
