export const AUTHENTICATED_HOME_PATHNAME = '/home' as const

export interface AuthenticatedHomeTarget {
  pathname: typeof AUTHENTICATED_HOME_PATHNAME
}

export function buildAuthenticatedHomeTarget(): AuthenticatedHomeTarget {
  return {
    pathname: AUTHENTICATED_HOME_PATHNAME,
  }
}
