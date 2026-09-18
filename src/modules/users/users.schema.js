import { z } from 'zod';

import { fullName, password } from '../auth/auth.schema.js';

/*
  Email is deliberately absent. Changing it is an identity change, not a profile
  edit: it would need re-verification of the new address and a way back if the
  old one is lost. Out of scope for ticket 03.
*/
const updateMeBody = z.object({ fullName });

const changePasswordBody = z.object({
    // Not shape-checked: an existing password that predates a rule change must
    // still be typeable in order to be replaced.
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: password,
});

export { updateMeBody, changePasswordBody };
