import { createSlice } from '@reduxjs/toolkit';
import { Zenon } from 'znn-ts-sdk';
import { defaultNodeUrl, getCurrentNodeUrl } from '../utils/storage';

const initialState = {
  // What the wallet is actually pointed at, preferring what was chosen last
  // over the wallet's own compiled-in default.
  nodeUrl: getCurrentNodeUrl() || defaultNodeUrl,
  // Whatever was last chosen under node settings, so a site that asks before
  // the wallet is unlocked is told the chain it would really be signed for.
  // The SDK falls back to mainnet when nothing has been stored yet.
  chainIdentifier: Zenon.getChainIdentifier(),
  // Whether the websocket is up. Screens used to fire RPC calls at a socket
  // that had gone away and surface the timeout as a red toast with no
  // explanation; the header shows this instead.
  isConnected: false,
};

export const connectionParametersSlice = createSlice({
  name: 'connectionParameters',
  initialState,
  reducers: {
    resetConnectionParametersState: () => initialState,
    storeNodeUrl: (state, action) => {
      state.nodeUrl = action.payload;
    },
    storeChainIdentifier: (state, action) => {
      state.chainIdentifier = action.payload;
    },
    storeIsConnected: (state, action) => {
      state.isConnected = action.payload;
    },
  },
});

export const {
  resetConnectionParametersState,
  storeNodeUrl,
  storeChainIdentifier,
  storeIsConnected,
} = connectionParametersSlice.actions;

export default connectionParametersSlice.reducer;
