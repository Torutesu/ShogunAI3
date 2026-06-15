import { clerkMiddleware } from '@clerk/nextjs/server';

export default clerkMiddleware();

export const config = {
  matcher: [
    '/checkout(.*)',
    '/welcome(.*)',
    '/account(.*)',
    '/api/checkout(.*)',
    '/api/entitlement(.*)',
  ],
};
