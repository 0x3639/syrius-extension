import { Constants } from 'znn-ts-sdk';

const fallbackValues = {
  decimals: 8,
  availableTokens: {
    "zts1znnxxxxxxxxxxxxx9z4ulx":{
      balance: 0,
      token:{
        decimals: 8,
        symbol: "ZNN",
        tokenStandard: "zts1znnxxxxxxxxxxxxx9z4ulx"
      }
    },
    "zts1qsrxxxxxxxxxxxxxmrhjll": {
      balance: 0,
      token:{
        decimals: 8,
        symbol: "QSR",
        tokenStandard: "zts1qsrxxxxxxxxxxxxxmrhjll"
      }
    }
  },
  emptyAddress: Constants.emptyAddress,
  emptyTokenStandard: Constants.emptyTokenStandard,
  emptyZts: Constants.emptyZts,
  stakingDurations: [
    {
      label: "1 Month",
      value: 2592000
    },
    {
      label: "2 Months",
      value: 5184000
    },
    {
      label: "3 Months",
      value: 7776000
    },
    {
      label: "4 Months",
      value: 10368000
    },
    {
      label: "5 Months",
      value: 12960000
    },
    {
      label: "6 Months",
      value: 15552000
    },
    {
      label: "7 Months",
      value: 18144000
    },
    {
      label: "8 Months",
      value: 20736000
    },
    {
      label: "9 Months",
      value: 23328000
    },
    {
      label: "10 Months",
      value: 25920000
    },
    {
      label: "11 Months",
      value: 28512000
    },
    {
      label: "12 Months",
      value: 31104000
    },
  ]
}

export default fallbackValues