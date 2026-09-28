import { KeyStoreManager } from 'znn-ts-sdk';

const passwordCriteria =
  'Use at least 8 characters with a lowercase letter, an uppercase letter, a digit, and one of !@#$%^&*.';
const strongPassword = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])(?=.*[!@#$%^&*])(?=.{8,})/;

// React Hook Form requires true or a string error; JSX is not a validation error.
const validateWalletPassword = (password) =>
  typeof password === 'string' && strongPassword.test(password) ? true : passwordCriteria;

// Only new passwords are subject to this policy. Existing passwords must still
// work for unlocking, rotation, recovery-phrase export, and wallet removal.
const saveWalletWithPassword = async (keyStore, password, walletName) => {
  const validation = validateWalletPassword(password);
  if (validation !== true) {
    throw new Error(validation);
  }
  return new KeyStoreManager().saveKeyStore(keyStore, password, walletName);
};

export { passwordCriteria, validateWalletPassword, saveWalletWithPassword };
