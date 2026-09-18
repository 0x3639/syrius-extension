import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import { useForm } from 'react-hook-form';
import { KeyStore, KeyStoreManager } from 'znn-ts-sdk';

import NavBack from '../../components/nav-back/nav-back';
import ProgressSteps from '../../components/progress-steps/progress-steps';
import fallbackValues from '../../services/utils/fallbackValues';
import { loadStorageWalletNames, sanitizeWalletName } from '../../services/utils/utils';
import { notify } from '../../services/utils/notify';
import { completeUnlock } from '../../services/wallet/bootstrap';

// Importing a wallet from its recovery phrase.
//
// The check on the phrase was `split(" ").length === 12 || === 24`. A recovery
// phrase has a checksum built into it precisely so that a mistyped word can be
// caught, and skipping that check is the worst possible failure for this
// screen: a phrase with one wrong word passes a word count, derives a
// different, valid, empty wallet, and the person is told their import
// succeeded while looking at a zero balance for coins that are still sitting at
// an address they can no longer reach.
//
// `KeyStore.fromMnemonic` runs the real BIP-39 validation and throws. That is
// what decides here now.

const normalise = (phrase) => phrase.trim().toLowerCase().replace(/\s+/g, ' ');

const Recovery = () => {
  const navigate = useNavigate();
  const dispatch = useDispatch();

  const [step, setStep] = useState(0);
  const [phrase, setPhrase] = useState('');
  const [walletName, setWalletName] = useState('');
  const [password, setPassword] = useState('');
  const [repeatPassword, setRepeatPassword] = useState('');
  const [isBusy, setIsBusy] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
  } = useForm();

  const { strongRegex, passwordCriteria } = fallbackValues.passwordValidationInfo;

  // Recomputed as it is typed so the message can say what is actually wrong,
  // rather than "Invalid mnemonic" for every case.
  const phraseState = useMemo(() => {
    const cleaned = normalise(phrase);

    if (!cleaned) {
      return { valid: false, message: '' };
    }
    const words = cleaned.split(' ');

    if (words.length !== 12 && words.length !== 24) {
      return { valid: false, message: `A recovery phrase has 12 or 24 words — this has ${words.length}` };
    }
    try {
      new KeyStore().fromMnemonic(cleaned);
      return { valid: true, message: '' };
    } catch (err) {
      // The SDK rejects both an unknown word and a bad checksum through the
      // same path, and the distinction does not help anyone reading it.
      return { valid: false, message: 'That phrase is not valid — check for a mistyped word' };
    }
  }, [phrase]);

  const validateWalletName = (name) => {
    if (!name?.trim()) {
      return 'Give this wallet a name';
    }
    if (loadStorageWalletNames().includes(sanitizeWalletName(name))) {
      return 'You already have a wallet with that name';
    }
    return true;
  };

  const finish = async () => {
    setIsBusy(true);

    try {
      const store = new KeyStore().fromMnemonic(normalise(phrase));
      const storageName = sanitizeWalletName(walletName);
      // Awaited, unlike before.
      await new KeyStoreManager().saveKeyStore(store, password, storageName);

      await completeUnlock({ walletName: storageName, password, dispatch });
      notify.success('Wallet imported');
      navigate('/tabs/dashboard', { replace: true });
    } catch (err) {
      notify.error(err);
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="black-bg onboarding-layout">
      <div className="onboarding-header">
        <NavBack />
        <h1>{step === 0 ? 'Recovery phrase' : 'Name and password'}</h1>
      </div>

      {step === 0 && (
        <>
          <div className="secret-phrase-container">
            <textarea
              placeholder="Your 12 or 24 word recovery phrase"
              rows="4"
              className="secret-phrase-text"
              value={phrase}
              spellCheck="false"
              autoComplete="off"
              autoFocus
              onChange={(event) => setPhrase(event.target.value)}
            />
          </div>

          <div className={`input-error ${phraseState.message ? '' : 'invisible'}`}>
            {phraseState.message || ' '}
          </div>

          <button
            type="button"
            className="button primary w-100 text-white"
            disabled={!phraseState.valid}
            onClick={() => setStep(1)}
          >
            Continue
          </button>
        </>
      )}

      {step === 1 && (
        <form onSubmit={handleSubmit(finish)}>
          <div className="custom-control">
            <input
              {...register('walletNameField', { required: true, validate: validateWalletName })}
              className={`w-100 custom-label ${errors.walletNameField ? 'custom-label-error' : ''}`}
              placeholder="Wallet name"
              value={walletName}
              onChange={(event) => {
                setWalletName(event.target.value);
                setValue('walletNameField', event.target.value, { shouldValidate: true });
              }}
              type="text"
              autoFocus
            />
            <div className={`input-error ${errors.walletNameField ? '' : 'invisible'}`}>
              {errors.walletNameField?.message || 'Wallet name is required'}
            </div>
          </div>

          <div className="custom-control">
            <input
              {...register('passwordField', {
                required: true,
                validate: (value) => strongRegex.test(value) || passwordCriteria,
              })}
              className={`w-100 custom-label ${errors.passwordField ? 'custom-label-error' : ''}`}
              placeholder="Password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setValue('passwordField', event.target.value, { shouldValidate: true });
              }}
              type="password"
            />
            <div className={`input-error long-error-message ${errors.passwordField ? '' : 'invisible'}`}>
              {errors.passwordField?.message || 'Password is required'}
            </div>
          </div>

          <div className="custom-control">
            <input
              {...register('repeatPasswordField', {
                required: true,
                validate: (value) => value === password || "The passwords don't match",
              })}
              className={`w-100 custom-label ${
                errors.repeatPasswordField ? 'custom-label-error' : ''
              }`}
              placeholder="Repeat password"
              value={repeatPassword}
              onChange={(event) => {
                setRepeatPassword(event.target.value);
                setValue('repeatPasswordField', event.target.value, { shouldValidate: true });
              }}
              type="password"
            />
            <div className={`input-error ${errors.repeatPasswordField ? '' : 'invisible'}`}>
              {errors.repeatPasswordField?.message || 'Repeat your password'}
            </div>
          </div>

          <button type="submit" className="button primary w-100 text-white" disabled={isBusy}>
            {isBusy ? 'Importing…' : 'Import wallet'}
          </button>
        </form>
      )}

      <ProgressSteps currentStep={step} totalSteps={2} />
    </div>
  );
};

export default Recovery;
