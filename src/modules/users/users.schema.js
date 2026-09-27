import { z } from 'zod';

import { fullName, password } from '../auth/auth.schema.js';

// Email is deliberately absent. Changing it is an identity change, not a profile
// edit: it would need re-verification of the new address and a way back if the
// old one is lost. Out of scope for ticket 03.
const updateMeBody = z.object({ fullName });

const changePasswordBody = z.object({
    // Not shape-checked: an existing password that predates a rule change must
    // still be typeable in order to be replaced.
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: password,
});

// Deleting the account (ticket 11): a valid access token alone is not enough, so
// the person proves it again - their password, or for an account that has none
// (made through Google) a fresh Google ID token. Exactly one of the two; which one
// the account needs is the service's to say, since only it knows the account.
const deleteMeBody = z
    .strictObject({
        password: z.string().min(1).optional(),
        googleIdToken: z.string().min(1).optional(),
    })
    .refine((value) => Boolean(value.password) !== Boolean(value.googleIdToken), {
        message: 'Confirm with your password, or with Google if the account has no password',
        path: ['password'],
    });

export { updateMeBody, changePasswordBody, deleteMeBody };
