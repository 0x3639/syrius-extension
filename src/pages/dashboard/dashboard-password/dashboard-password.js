import React, { useEffect, useRef, useState } from 'react';
import { useDispatch } from 'react-redux';
import { useLocation, useNavigate } from 'react-router-dom';

import MenuHeader from '../../menu/menu-header/menu-header';
import ControlledDropdown from '../../../components/custom-dropdown/controlled-dropdown';
import { useForm } from 'react-hook-form';

import { completeUnlock } from '../../../services/wallet/bootstrap';
import { loadStorageWalletNames } from '../../../services/utils/utils';
import { getLastWalletName } from '../../../services/utils/storage';
import { readDevWalletConfig } from '../../../services/utils/devWallet';
import { readableError } from '../../../services/utils/errors';
import { notify } from '../../../services/utils/notify';

// The unlock screen.
//
// What used to be here, besides the form: a full three.js scene — perspective
// camera, point light, directional light, a textured sphere and a
// `mousemove` listener that made it follow the pointer. That is 1.13 MiB of
// the bundle and a WebGL context, on the screen whose entire job is to accept a
// password quickly. It is gone.

const DashboardPassword = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useDispatch();

  const [walletNames, setWalletNames] = useState([]);
  const [selectedWallet, setSelectedWallet] = useState('');
  const [password, setPassword] = useState('');
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [wrongPassword, setWrongPassword] = useState(false);
  const passwordInput = useRef(null);

  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
    setValue,
  } = useForm();

  // Where to go once the wallet opens. A dApp approval sets this so the request
  // that opened the popup is not lost behind the password prompt.
  const returnTo = location.state?.returnTo || '/tabs/dashboard';

  const passwordField = register('passwordField', { required: true });

  const unlock = async (walletPassword, walletName) => {
    if (!walletName) {
      notify.error('Choose a wallet first.');
      return;
    }
    setIsUnlocking(true);
    setWrongPassword(false);

    try {
      await completeUnlock({ walletName, password: walletPassword, dispatch });
      navigate(returnTo, { replace: true });
    } catch (err) {
      const message = readableError(err);

      // A wrong password is the expected outcome here, not an incident. It gets
      // inline treatment on the field; anything else is a real error.
      if (message === 'Wrong password.') {
        setWrongPassword(true);
        setPassword('');
        setValue('passwordField', '', { shouldValidate: false });
        passwordInput.current?.focus();
      } else {
        notify.error(err);
      }
      setIsUnlocking(false);
    }
  };

  useEffect(() => {
    const wallets = loadStorageWalletNames();
    setWalletNames(wallets);

    // Returns null in every build that is not being driven by the dev harness,
    // which leaves this screen exactly as it is for everybody else.
    const devWallet = readDevWalletConfig();

    if (devWallet) {
      setSelectedWallet(devWallet.walletName);
      setValue('selectedWalletField', devWallet.walletName, { shouldValidate: true });
      unlock(devWallet.password, devWallet.walletName);
      return;
    }

    // One wallet is the overwhelmingly common case; preselecting it turns the
    // screen into a single field. With more than one, default to whichever
    // unlocked last rather than leaving the picker blank every time.
    const preselected =
      wallets.length === 1 ? wallets[0] : wallets.find((name) => name === getLastWalletName());

    if (preselected) {
      setSelectedWallet(preselected);
      setValue('selectedWalletField', preselected, { shouldValidate: true });
    }
    passwordInput.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSelectWallet = (index, value) => {
    setSelectedWallet(value);
    setValue('selectedWalletField', value, { shouldValidate: true });
  };

  return (
    <div className="black-bg screen">
      <MenuHeader changeNodeButton />

      <div className="screen-body unlock-screen">
        <div className="unlock-mark">
          <img alt="" src={require('../../../assets/logo.svg')} width="52" />
        </div>
        <h2 className="unlock-title">Welcome back</h2>

        <form onSubmit={handleSubmit(() => unlock(password, selectedWallet))}>
          {walletNames.length > 1 && (
            <div className="custom-control">
              <ControlledDropdown
                dropdownComponent="CustomDropdown"
                {...register('selectedWalletField', { required: true })}
                control={control}
                name="selectedWalletField"
                options={walletNames}
                onChange={onSelectWallet}
                value={selectedWallet}
                placeholder="Select wallet"
                className={errors.selectedWalletField ? 'custom-label-error' : ''}
              />
              <div className={`input-error ${errors.selectedWalletField ? '' : 'invisible'}`}>
                Choose a wallet
              </div>
            </div>
          )}

          <div className="custom-control">
            <input
              {...passwordField}
              ref={(element) => {
                // react-hook-form wants the node and so does the wrong-password
                // path, which puts the cursor back in the field.
                passwordField.ref(element);
                passwordInput.current = element;
              }}
              className={`w-100 custom-label ${
                errors.passwordField || wrongPassword ? 'custom-label-error' : ''
              }`}
              placeholder="Password"
              autoFocus
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setWrongPassword(false);
                setValue('passwordField', event.target.value, { shouldValidate: true });
              }}
              type="password"
            />
            <div
              className={`input-error ${errors.passwordField || wrongPassword ? '' : 'invisible'}`}
            >
              {wrongPassword ? 'Wrong password' : 'Password is required'}
            </div>
          </div>

          <button
            type="submit"
            className="button primary w-100 text-white"
            disabled={isUnlocking}
          >
            {isUnlocking ? 'Unlocking…' : 'Unlock'}
          </button>
        </form>

        <div className="unlock-alternative text-gray">
          <span
            className="text-primary cursor-pointer"
            onClick={() => navigate('/auth/onboarding')}
          >
            Create or import a wallet
          </span>
        </div>
      </div>
    </div>
  );
};

export default DashboardPassword;
