import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import { useForm } from 'react-hook-form';
import { KeyStoreManager } from 'znn-ts-sdk';

import NavBack from '../../components/nav-back/nav-back';
import OrderWords from '../../components/order-words/order-words';
import ProgressSteps from '../../components/progress-steps/progress-steps';
import fallbackValues from '../../services/utils/fallbackValues';
import { arrayShuffle, loadStorageWalletNames, sanitizeWalletName } from '../../services/utils/utils';
import { copyToClipboard, notify } from '../../services/utils/notify';
import { completeUnlock } from '../../services/wallet/bootstrap';

// Creating a wallet.
//
// Two things were wrong at the end of it. `saveKeyStore(...)` was called
// without `await`, so the flow moved on before the keystore had been written
// and a failure there surfaced as an unhandled rejection while the screen said
// the wallet was ready. And the last step read "Open the extension and sign in"
// — advice given from inside the extension, to somebody who had just typed the
// password it was asking them to go and type. It now opens the wallet.

const steps = ['Choose a password', 'Your recovery phrase', 'Confirm the phrase'];

const GetStarted = () => {
  const navigate = useNavigate();
  const dispatch = useDispatch();

  const [step, setStep] = useState(0);
  const [walletName, setWalletName] = useState('');
  const [password, setPassword] = useState('');
  const [repeatPassword, setRepeatPassword] = useState('');

  const [keyStore, setKeyStore] = useState(null);
  const [mnemonic, setMnemonic] = useState('');
  const [shuffled, setShuffled] = useState([]);
  const [ordered, setOrdered] = useState([]);
  const [hasSavedPhrase, setHasSavedPhrase] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
  } = useForm();

  const { strongRegex, passwordCriteria } = fallbackValues.passwordValidationInfo;

  const validateWalletName = (name) => {
    if (!name?.trim()) {
      return 'Give this wallet a name';
    }
    if (loadStorageWalletNames().includes(sanitizeWalletName(name))) {
      return 'You already have a wallet with that name';
    }
    return true;
  };

  const createKeyStore = async () => {
    setIsBusy(true);

    try {
      const store = await new KeyStoreManager().getNewKeystore();
      setKeyStore(store);
      setMnemonic(store.mnemonic);
      setShuffled(arrayShuffle(store.mnemonic.split(' ')));
      setStep(1);
    } catch (err) {
      notify.error(err);
    } finally {
      setIsBusy(false);
    }
  };

  const isPhraseCorrect =
    ordered.length === mnemonic.split(' ').length &&
    ordered.every((word, index) => word === mnemonic.split(' ')[index]);

  const finish = async () => {
    if (!isPhraseCorrect) {
      return;
    }
    setIsBusy(true);

    try {
      const storageName = sanitizeWalletName(walletName);
      // Awaited, unlike before: nothing may claim the wallet exists until it
      // has actually been written.
      await new KeyStoreManager().saveKeyStore(keyStore, password, storageName);

      // Straight into the wallet with the password just chosen, rather than
      // sending somebody to a login screen they have every reason to think
      // they have already passed.
      await completeUnlock({ walletName: storageName, password, dispatch });
      notify.success('Wallet created');
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
        <h1>{steps[step]}</h1>
      </div>

      {step === 0 && (
        <form onSubmit={handleSubmit(createKeyStore)}>
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

          <p className="text-gray text-xs">
            This password encrypts the wallet on this computer. It cannot be recovered.
          </p>

          <button type="submit" className="button primary w-100 text-white" disabled={isBusy}>
            {isBusy ? 'Creating…' : 'Continue'}
          </button>
        </form>
      )}

      {step === 1 && (
        <>
          <p className="text-gray">
            These twelve words are the only way back into this wallet. Write them down and keep
            them offline.
          </p>

          <div className="secret-phrase-container">
            <div className="secret-phrase-text">{mnemonic}</div>
            <button
              type="button"
              className="copy-button"
              onClick={() => copyToClipboard(mnemonic, 'Recovery phrase copied')}
            >
              <img alt="" src={require('./../../assets/copy-icon.png')} width="14" />
            </button>
          </div>

          <div className="custom-checkbox-container">
            <label className="custom-checkbox" htmlFor="agree_phrase">
              <input
                className="custom-checkbox"
                id="agree_phrase"
                type="checkbox"
                checked={hasSavedPhrase}
                onChange={() => setHasSavedPhrase((saved) => !saved)}
              />
              <span className="custom-checkmark" />
              I have written the phrase down
            </label>
          </div>

          <button
            type="button"
            className="button primary w-100 text-white"
            disabled={!hasSavedPhrase}
            onClick={() => setStep(2)}
          >
            Continue
          </button>
        </>
      )}

      {step === 2 && (
        <>
          <p className="text-gray">Tap the words in the right order.</p>

          <OrderWords ordered={ordered} setOrder={setOrdered} shuffled={shuffled} />

          <div className={`input-error ${ordered.length && !isPhraseCorrect ? '' : 'invisible'}`}>
            That is not the right order
          </div>

          <button
            type="button"
            className="button primary w-100 text-white"
            disabled={!isPhraseCorrect || isBusy}
            onClick={finish}
          >
            {isBusy ? 'Creating…' : 'Create wallet'}
          </button>
        </>
      )}

      <ProgressSteps currentStep={step} totalSteps={steps.length} />
    </div>
  );
};

export default GetStarted;
