
//mock data
function getStock(){

const ticker = document.getElementById("ticker").value.toUpperCase()

const data = {
    ticker: ticker,
    price: "$182.44",
    sentiment: "Positive",
    news:[
        "Apple releases new AI chip",
        "iPhone demand increases",
        "Investors bullish on Apple"
    ],
    prices:[170,172,168,175,178,180,182]
}

document.getElementById("stockName").innerText = data.ticker
document.getElementById("price").innerText = "Price: " + data.price
document.getElementById("sentiment").innerText = "Sentiment: " + data.sentiment


// NEWS
const newsList = document.getElementById("newsList")
newsList.innerHTML = ""

data.news.forEach(article=>{

    const li = document.createElement("li")
    li.innerText = article
    newsList.appendChild(li)

})


// CHART
const ctx = document.getElementById('stockChart').getContext('2d')

new Chart(ctx, {
    type: 'line',
    data: {
        labels: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],
        datasets: [{
            label: ticker + " Price",
            data: data.prices,
            borderColor: "#00ff88",
            backgroundColor: "rgba(0,255,136,0.1)",
            tension:0.4
        }]
    },
    options:{
        responsive:true,
        plugins:{
            legend:{
                labels:{color:"white"}
            }
        },
        scales:{
            x:{ticks:{color:"white"}},
            y:{ticks:{color:"white"}}
        }
    }
})

}